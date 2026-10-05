/**
 * Library read — the runtime librarian's second half.
 *
 * `readLibraryEntry(id, part)` loads one entry from the library shipped under
 * PACKAGE_ROOT and renders it for an agent:
 *
 *   skill      SKILL.md body + metadata (status, use_when, related) + how to
 *              invoke it in the host (bare slug)
 *   tool       how to call it (MCP name, `summer tool <slug> --args`, engine
 *              requirement, authority) + the descriptor (resource.yaml)
 *   template   the pin (repo @ commit, tree digest) or "built-in" + the
 *              `summer create <slug>` command
 *   reference  the markdown body
 *   example / collection   README.md / collection.yaml when present
 *
 * The LAST line of every load is the feedback footer
 * (SELF_IMPROVING_LIBRARY.md §3.1 "trigger placement"):
 *   — entry_id: <id>@<content_hash first 12>. If this entry is wrong, stale,
 *   or you deviate from it, report via summer_library_feedback.
 * The agent copies that entry_id verbatim into summer_library_feedback, so
 * feedback attributes to the exact bytes it used (CONTRACT §4).
 *
 * Metadata comes from registry/generated/index.json (no YAML parser at
 * runtime); resource.yaml is returned as text. Unknown id -> not_found with
 * the three nearest ids from searchLibrary.
 *
 * Linked files: a body links files its entry ships (a skill's
 * `references/kit-placement-tools.md`) and other entries
 * (`../setup-multiplayer/SKILL.md`, `../../references/gd-style/gd-style.md`).
 * Each loads by `<entry id>/<link as written>`, resolved inside library/ only
 * and for text files only; by the relative path alone when exactly one entry
 * ships it; and `reference/<slug>` that is no entry falls back to the one
 * `references/<slug>.md` an entry ships. A body render ends with its links and
 * the id that loads each. A linked file's footer names its entry.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { z } from "zod";
import {
  LIBRARY_KIND_DIRS,
  loadLibraryIndex,
  searchLibrary,
  type LibraryIndexEntry,
  type LibraryKind,
  type LibrarySearchDeps,
} from "./library-search.js";
import { PACKAGE_ROOT } from "./package-root.js";
import { getTemplateRegistry, type TemplateEntry } from "./templates.js";

export const READ_PARTS = ["skill", "resource", "all"] as const;
export type ReadPart = (typeof READ_PARTS)[number];

/** How many content_hash hex chars the footer's entry_id carries. */
export const FOOTER_HASH_LENGTH = 12;
export const FOOTER_SUFFIX = "If this entry is wrong, stale, or you deviate from it, report via summer_library_feedback.";

/** Text files read_library loads when an entry links them. */
export const LINKED_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".yaml",
  ".yml",
  ".json",
  ".gd",
  ".gdshader",
  ".shader",
  ".cfg",
  ".tscn",
  ".tres",
  ".csv",
]);
/** A linked file larger than this is refused rather than dumped. */
export const LINKED_FILE_MAX_BYTES = 256 * 1024;

export const readLibraryInputShape = {
  id: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "The entry id as returned by summer_search_library: <kind>/<slug>, e.g. skill/vfx-water-ripple or tool/screenshot. A file an entry links loads by <entry id>/<link as written>, e.g. skill/spatial-placement/references/kit-placement-tools.md; the 'linked files' list at the end of a body gives each id."
    ),
  part: z
    .enum(READ_PARTS)
    .optional()
    .describe(
      "'skill' = the body only (SKILL.md for skills; the markdown body for references; how-to-call for tools; the pin for templates). 'resource' = the resource.yaml descriptor only. 'all' (default) = both."
    ),
};

export const readLibraryInputSchema = z.object(readLibraryInputShape).strict();
export type ReadLibraryArgs = z.infer<typeof readLibraryInputSchema>;

export interface LibraryReadDeps extends LibrarySearchDeps {
  /** Root holding library/ (default: the installed package). */
  packageRoot?: string;
  templates?: readonly TemplateEntry[];
}

export interface LibraryReadOk {
  ok: true;
  id: string;
  kind: string;
  slug: string;
  version: string;
  status: string;
  content_hash: string;
  summary: string;
  use_when: string[];
  related: Record<string, string[]>;
  part: ReadPart;
  /** Package-root-relative resource directory, e.g. "library/skills/<slug>". */
  path: string;
  /** Top-level files in the resource directory. */
  files: string[];
  /** The file the body came from, when the body is a file. */
  body_file?: string;
  /** Set when the load is a file the entry ships rather than the entry body:
   *  its path inside the entry directory, e.g. "references/kit-placement-tools.md". */
  linked_file?: string;
  /** Relative links in the body and the summer_read_library id that loads
   *  each (null: the target is not shipped with this package). */
  links?: Array<{ target: string; id: string | null }>;
  /** Tool records: how to reach it. */
  mcp_tool_name?: string;
  cli_command?: string;
  remote?: boolean;
  authority?: Record<string, boolean>;
  /** The id to report with (id@hash12); also the last line's subject. */
  entry_id: string;
  footer: string;
  /** The full load as the agent should read it; `footer` is its last line. */
  text: string;
}

export interface LibraryReadNotFound {
  ok: false;
  error: "not_found";
  id: string;
  nearest: string[];
  hint: string;
}

export type LibraryReadResult = LibraryReadOk | LibraryReadNotFound;

/** The feedback footer for an entry; `hash` may be empty for a hash-less index. */
export function feedbackFooter(id: string, contentHash: string | undefined): string {
  return `— entry_id: ${entryIdWithHash(id, contentHash)}. ${FOOTER_SUFFIX}`;
}

export function entryIdWithHash(id: string, contentHash: string | undefined): string {
  const hash = typeof contentHash === "string" ? contentHash.slice(0, FOOTER_HASH_LENGTH) : "";
  return hash ? `${id}@${hash}` : id;
}

// ── Resolution ─────────────────────────────────────────────────────────────

/** Exact id, an id with an @hash suffix (as the footer prints it), or a bare
 *  slug that names exactly one entry. */
function resolveEntry(requested: string, entries: LibraryIndexEntry[]): LibraryIndexEntry | null {
  const bare = requested.trim().replace(/@[a-f0-9]+$/i, "");
  if (!bare) return null;
  const exact = entries.find((entry) => entry.id === bare);
  if (exact) return exact;
  if (!bare.includes("/")) {
    const bySlug = entries.filter((entry) => entry.id.split("/").pop() === bare);
    if (bySlug.length === 1) return bySlug[0]!;
  }
  return null;
}

const KIND_BY_DIR = new Map<string, LibraryKind>(
  Object.entries(LIBRARY_KIND_DIRS).map(([kind, dir]) => [dir, kind as LibraryKind])
);
const ENTRY_PATH_ID = /^(tool|skill|example|template|collection|reference)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/;

/** A file inside an entry's directory ("" = the entry directory itself). */
interface FileTarget {
  entry: LibraryIndexEntry;
  file: string;
}

function entryDirOf(entry: LibraryIndexEntry): string {
  const kind = entry.kind as LibraryKind;
  return `library/${LIBRARY_KIND_DIRS[kind] ?? `${kind}s`}/${entry.id.split("/").pop()!}`;
}

/** Join a link onto a package-relative directory; null when it is absolute,
 *  malformed, or leaves library/. */
function joinInsideLibrary(baseDir: string, link: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(link.trim());
  } catch {
    return null;
  }
  if (!decoded || /[\u0000-\u001f\\]/.test(decoded) || decoded.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null;
  const joined = posix.normalize(posix.join(baseDir, decoded)).replace(/\/+$/, "");
  return joined === "library" || joined.startsWith("library/") ? joined : null;
}

/** library/<dir>/<slug>[/<file>] -> the entry and the file inside it. */
function targetFromLibraryPath(libPath: string, entries: LibraryIndexEntry[]): FileTarget | null {
  const parts = libPath.split("/");
  if (parts.length < 3 || parts[0] !== "library") return null;
  const kind = KIND_BY_DIR.get(parts[1]!);
  if (!kind) return null;
  const entry = entries.find((e) => e.id === `${kind}/${parts[2]}`);
  return entry ? { entry, file: parts.slice(3).join("/") } : null;
}

function isFileInsideLibrary(root: string, libPath: string): boolean {
  const abs = join(root, ...libPath.split("/"));
  try {
    if (!statSync(abs).isFile()) return false;
    const libraryRoot = realpathSync(join(root, "library"));
    return realpathSync(abs).startsWith(libraryRoot + sep);
  } catch {
    return false;
  }
}

/** Resolve an id that names a file an entry ships (see the module comment). */
function resolveLinkedFile(requested: string, entries: LibraryIndexEntry[], root: string): FileTarget | null {
  const bare = requested.trim();
  const qualified = ENTRY_PATH_ID.exec(bare);
  if (qualified) {
    const entry = entries.find((e) => e.id === `${qualified[1]}/${qualified[2]}`);
    if (entry) {
      const libPath = joinInsideLibrary(entryDirOf(entry), qualified[3]!);
      const target = libPath ? targetFromLibraryPath(libPath, entries) : null;
      if (!target || (target.file !== "" && !isFileInsideLibrary(root, libPath!))) return null;
      return target;
    }
  }
  const shipping = (relative: string): FileTarget[] =>
    entries
      .map((entry) => ({ entry, libPath: joinInsideLibrary(entryDirOf(entry), relative) }))
      .filter((c): c is { entry: LibraryIndexEntry; libPath: string } => !!c.libPath && c.libPath.startsWith(`${entryDirOf(c.entry)}/`))
      .filter((c) => isFileInsideLibrary(root, c.libPath))
      .map((c) => ({ entry: c.entry, file: c.libPath.slice(entryDirOf(c.entry).length + 1) }));
  // A relative path alone, when exactly one entry ships that file.
  if ((bare.includes("/") || /\.[a-z0-9]+$/i.test(bare)) && !bare.startsWith("../")) {
    const found = shipping(bare.replace(/^\.\//, ""));
    if (found.length === 1) return found[0]!;
  }
  // reference/<slug> that is no entry: the references/<slug>.md one entry ships.
  const asReference = /^references?\/([a-z0-9]+(?:[-_][a-z0-9]+)*)(?:\.md)?$/.exec(bare);
  if (asReference) {
    const found = shipping(`references/${asReference[1]}.md`);
    if (found.length === 1) return found[0]!;
  }
  return null;
}

/**
 * Relative link targets in a markdown body: markdown links outside code
 * (`[x](references/y.md)`, fragment dropped) and inline code spans that name a
 * library file by a relative path (`../../references/gd-style/gd-style.md`,
 * `references/y.md`; a `./scripts/x.gd` span is a project path and is not
 * one). URLs, anchors, absolute paths and fenced code blocks are skipped.
 * Exported for the every-link-resolves test.
 */
export function relativeLinkTargets(markdown: string): string[] {
  const out = new Set<string>();
  const text = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1]!.trim();
    if (/^((\.\.\/)+|(\.\/)?references\/)[^\s*?<>|]+\.[A-Za-z0-9]+$/.test(span)) out.add(span);
  }
  const prose = text.replace(/`[^`\n]*`/g, "");
  for (const match of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = match[1]!;
    if (target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const path = target.split("#")[0]!;
    if (path) out.add(path);
  }
  return [...out];
}

// ── Rendering ──────────────────────────────────────────────────────────────

function readText(file: string): string | null {
  try {
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf-8") : null;
  } catch {
    return null;
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function pickBodyFile(kind: string, slug: string, dir: string): string | null {
  const files = listFiles(dir);
  const has = (name: string) => files.includes(name);
  switch (kind) {
    case "skill":
      return has("SKILL.md") ? "SKILL.md" : null;
    case "reference": {
      if (has(`${slug}.md`)) return `${slug}.md`;
      return files.find((f) => f.toLowerCase().endsWith(".md")) ?? null;
    }
    case "example":
      return has("README.md") ? "README.md" : null;
    case "collection":
      if (has("README.md")) return "README.md";
      return has("collection.yaml") ? "collection.yaml" : null;
    default:
      return null;
  }
}

/** The summer_read_library id that loads a target: the entry id for the
 *  entry itself or its body file, else <entry id>/<file>. */
function canonicalId(target: FileTarget, root: string): string {
  if (target.file === "") return target.entry.id;
  const slug = target.entry.id.split("/").pop()!;
  const body = pickBodyFile(target.entry.kind, slug, join(root, ...entryDirOf(target.entry).split("/")));
  return target.file === body ? target.entry.id : `${target.entry.id}/${target.file}`;
}

/**
 * Where a link written in `fromFile` (a path inside `entry`'s directory, ""
 * or "SKILL.md" for the body) points, as the id summer_read_library loads it
 * by; null when the target is not shipped inside library/.
 */
export function resolveLibraryLink(
  entry: LibraryIndexEntry,
  fromFile: string,
  link: string,
  deps: { entries: LibraryIndexEntry[]; packageRoot?: string }
): string | null {
  const root = deps.packageRoot ?? PACKAGE_ROOT;
  const libPath = joinInsideLibrary(posix.dirname(posix.join(entryDirOf(entry), fromFile || "_")), link);
  if (!libPath) return null;
  const target = targetFromLibraryPath(libPath, deps.entries);
  if (!target) return null;
  if (target.file !== "" && !isFileInsideLibrary(root, libPath)) return null;
  return canonicalId(target, root);
}

function linksOf(body: string, entry: LibraryIndexEntry, fromFile: string, entries: LibraryIndexEntry[], root: string) {
  return relativeLinkTargets(body).map((target) => ({ target, id: resolveLibraryLink(entry, fromFile, target, { entries, packageRoot: root }) }));
}

function linksSection(links: Array<{ target: string; id: string | null }>): string {
  const lines = ["--- linked files (load each with summer_read_library and the id after the arrow) ---"];
  for (const link of links) lines.push(`${link.target} -> ${link.id ?? "(not shipped with this package)"}`);
  return lines.join("\n");
}

function toolBody(entry: LibraryIndexEntry, slug: string): string {
  const lines: string[] = [];
  const mcpName = entry.mcp_tool_name ?? `summer_${slug.replace(/-/g, "_")}`;
  lines.push(`MCP: call \`${mcpName}\` with arguments matching input_schema (in resource.yaml below).`);
  lines.push(`Shell: summer tool ${slug} --args '<json matching input_schema>'`);
  if (entry.cli_command) lines.push(`Dedicated command: ${entry.cli_command}`);
  lines.push(
    entry.remote === true
      ? "Engine: not required (remote: true — works without a running Summer Engine)."
      : "Engine: required — Summer Engine must be running with the project open (start it with `summer run`)."
  );
  if (entry.authority) {
    const granted = Object.entries(entry.authority)
      .filter(([, on]) => on === true)
      .map(([name]) => name);
    lines.push(`Authority: ${granted.length > 0 ? granted.join(", ") : "none (read-only)"}.`);
  }
  return lines.join("\n");
}

function templateBody(slug: string, templates: readonly TemplateEntry[]): string {
  const template = templates.find((t) => t.slug === slug);
  const lines: string[] = [];
  if (!template) {
    lines.push("Pin: not present in registry/generated/templates-registry.json (regenerate the registry).");
  } else if (template.builtin) {
    lines.push("Built-in template: generated locally by `summer create`, nothing is downloaded.");
  } else if (template.pin) {
    lines.push(`Pinned to ${template.pin.repo} @ ${template.pin.commit}`);
    lines.push(`tree_digest: ${template.pin.tree_digest} (verified after fetch; mismatch writes nothing)`);
  }
  if (template && template.systems.length > 0) lines.push(`Systems: ${template.systems.join(", ")}`);
  if (template && template.do_not_use_when.length > 0) {
    lines.push("Do not use when:");
    for (const line of template.do_not_use_when) lines.push(`  - ${line}`);
  }
  lines.push(`Create a project from it: summer create ${slug} [name]   (records the pin into .summer/project.json)`);
  return lines.join("\n");
}

function relatedMap(entry: LibraryIndexEntry): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [group, ids] of Object.entries(entry.related ?? {})) {
    if (Array.isArray(ids) && ids.length > 0) out[group] = [...ids];
  }
  return out;
}

function header(entry: LibraryIndexEntry, slug: string, related: Record<string, string[]>): string {
  const lines: string[] = [];
  lines.push(`${entry.id} — ${entry.kind} v${entry.version ?? "?"} (${entry.status ?? "stable"})`);
  if (entry.summary) lines.push(entry.summary);
  const useWhen = Array.isArray(entry.use_when) ? entry.use_when : [];
  if (useWhen.length > 0) {
    lines.push("use_when:");
    for (const line of useWhen) lines.push(`  - ${line}`);
  }
  const relatedIds = Object.values(related).flat();
  if (relatedIds.length > 0) lines.push(`related: ${relatedIds.join(", ")}`);
  if (entry.kind === "skill") {
    lines.push(
      `Invoke: the \`${slug}\` skill in your host (Claude Code: /${slug}); installed under its bare slug by \`summer setup\`. The body follows — follow it, do not paraphrase it.`
    );
  }
  return lines.join("\n");
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Read one entry, or a file an entry links. `deps.entries`/`deps.packageRoot`/
 * `deps.templates` let tests point at a fixture; production reads the
 * installed package.
 */
export async function readLibraryEntry(
  requestedId: string,
  part: ReadPart = "all",
  deps: LibraryReadDeps = {}
): Promise<LibraryReadResult> {
  const entries = deps.entries ?? loadLibraryIndex();
  const root = deps.packageRoot ?? PACKAGE_ROOT;
  let entry = resolveEntry(requestedId, entries);
  let linkedFile: string | undefined;
  if (!entry) {
    const target = resolveLinkedFile(requestedId, entries, root);
    if (target) {
      entry = target.entry;
      const canonical = canonicalId(target, root);
      // The entry's own body file and resource.yaml render as the entry.
      if (target.file === "resource.yaml") part = "resource";
      else if (canonical !== entry.id) linkedFile = target.file;
    }
  }
  if (!entry) {
    const query = requestedId.replace(/[/@_.-]+/g, " ").replace(/[a-f0-9]{8,}/gi, " ").replace(/\bmd\b/g, " ").trim() || requestedId;
    const nearest = (await searchLibrary(query, { limit: 3 }, deps)).map((hit) => hit.id);
    return {
      ok: false,
      error: "not_found",
      id: requestedId,
      nearest,
      hint:
        (nearest.length > 0
          ? `No library entry has id "${requestedId}". Nearest by search: ${nearest.join(", ")}. Ids are <kind>/<slug>; use summer_search_library to find the right one.`
          : `No library entry has id "${requestedId}" and nothing similar was found. Ids are <kind>/<slug>; use summer_search_library.`) +
        " A file an entry links loads by <entry id>/<link as written> (inside library/ only).",
    };
  }

  const kind = entry.kind as LibraryKind;
  const slug = entry.id.split("/").pop()!;
  const relPath = entryDirOf(entry);
  const dir = join(root, ...relPath.split("/"));
  const files = listFiles(dir);
  const related = relatedMap(entry);
  const footer = feedbackFooter(entry.id, entry.content_hash);
  const resourceYaml = readText(join(dir, "resource.yaml"))?.replace(/\s+$/, "") ?? "(resource.yaml not found in this install)";

  const base = {
    ok: true as const,
    id: entry.id,
    kind: entry.kind,
    slug,
    version: entry.version ?? "",
    status: entry.status ?? "stable",
    content_hash: entry.content_hash ?? "",
    summary: entry.summary ?? "",
    use_when: Array.isArray(entry.use_when) ? entry.use_when : [],
    related,
    part,
    path: relPath,
    files,
    entry_id: entryIdWithHash(entry.id, entry.content_hash),
    footer,
  };

  if (linkedFile !== undefined) {
    const libPath = `${relPath}/${linkedFile}`;
    const extension = posix.extname(linkedFile).toLowerCase();
    const size = (() => {
      try {
        return statSync(join(root, ...libPath.split("/"))).size;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    })();
    const sections: string[] = [
      `${entry.id}/${linkedFile} — a file shipped with ${entry.id} (${entry.kind} v${entry.version ?? "?"}, ${entry.status ?? "stable"}). The entry itself: summer_read_library id "${entry.id}".`,
    ];
    let links: Array<{ target: string; id: string | null }> = [];
    if (part === "resource") {
      sections.push(`--- ${relPath}/resource.yaml ---\n${resourceYaml}`);
    } else if (!LINKED_FILE_EXTENSIONS.has(extension)) {
      sections.push(`--- ${libPath} ---\n(not a text file read_library loads: ${extension || "no extension"}; it ships at ${libPath} in the package)`);
    } else if (size > LINKED_FILE_MAX_BYTES) {
      sections.push(`--- ${libPath} ---\n(${size} bytes, over the ${LINKED_FILE_MAX_BYTES}-byte limit for a linked file; it ships at ${libPath} in the package)`);
    } else {
      const text = readText(join(root, ...libPath.split("/")))?.replace(/\s+$/, "") ?? "(file could not be read)";
      sections.push(`--- ${libPath} ---\n${text}`);
      if (extension === ".md" || extension === ".markdown") {
        links = linksOf(text, entry, linkedFile, entries, root);
        if (links.length > 0) sections.push(linksSection(links));
      }
    }
    sections.push(footer);
    return {
      ...base,
      body_file: linkedFile,
      linked_file: linkedFile,
      ...(links.length > 0 ? { links } : {}),
      text: sections.join("\n\n"),
    };
  }

  let bodyFile: string | undefined;
  let bodyTitle: string;
  let body: string;
  let links: Array<{ target: string; id: string | null }> = [];
  if (kind === "tool") {
    bodyTitle = "how to call";
    body = toolBody(entry, slug);
  } else if (kind === "template") {
    bodyTitle = "pin";
    body = templateBody(slug, deps.templates ?? safeTemplates());
  } else {
    const picked = pickBodyFile(kind, slug, dir);
    const text = picked ? readText(join(dir, picked)) : null;
    if (picked && text !== null) {
      bodyFile = picked;
      bodyTitle = `${relPath}/${picked}`;
      body = text.replace(/\s+$/, "");
      if (picked.toLowerCase().endsWith(".md")) links = linksOf(body, entry, picked, entries, root);
    } else {
      bodyTitle = "body";
      body = `(no body file shipped for this ${kind}; the descriptor below is all there is)`;
    }
  }

  const sections: string[] = [header(entry, slug, related)];
  if (part === "skill" || part === "all") {
    sections.push(`--- ${bodyTitle} ---\n${body}`);
    if (links.length > 0) sections.push(linksSection(links));
  }
  if (part === "resource" || part === "all") sections.push(`--- ${relPath}/resource.yaml ---\n${resourceYaml}`);
  sections.push(footer);

  const result: LibraryReadOk = { ...base, text: sections.join("\n\n") };
  if (bodyFile) result.body_file = bodyFile;
  if (links.length > 0 && part !== "resource") result.links = links;
  if (kind === "tool") {
    if (entry.mcp_tool_name) result.mcp_tool_name = entry.mcp_tool_name;
    if (entry.cli_command) result.cli_command = entry.cli_command;
    result.remote = entry.remote === true;
    if (entry.authority) result.authority = entry.authority;
  }
  return result;
}

function safeTemplates(): readonly TemplateEntry[] {
  try {
    return getTemplateRegistry();
  } catch {
    return [];
  }
}
