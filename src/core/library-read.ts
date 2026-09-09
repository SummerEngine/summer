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
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

export const readLibraryInputShape = {
  id: z
    .string()
    .min(1)
    .max(200)
    .describe("The entry id as returned by summer_search_library: <kind>/<slug>, e.g. skill/vfx-water-ripple or tool/screenshot."),
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
 * Read one entry. `deps.entries`/`deps.packageRoot`/`deps.templates` let
 * tests point at a fixture; production reads the installed package.
 */
export async function readLibraryEntry(
  requestedId: string,
  part: ReadPart = "all",
  deps: LibraryReadDeps = {}
): Promise<LibraryReadResult> {
  const entries = deps.entries ?? loadLibraryIndex();
  const root = deps.packageRoot ?? PACKAGE_ROOT;
  const entry = resolveEntry(requestedId, entries);
  if (!entry) {
    const query = requestedId.replace(/[/@_-]+/g, " ").replace(/[a-f0-9]{8,}/gi, " ").trim() || requestedId;
    const nearest = (await searchLibrary(query, { limit: 3 }, deps)).map((hit) => hit.id);
    return {
      ok: false,
      error: "not_found",
      id: requestedId,
      nearest,
      hint:
        nearest.length > 0
          ? `No library entry has id "${requestedId}". Nearest by search: ${nearest.join(", ")}. Ids are <kind>/<slug>; use summer_search_library to find the right one.`
          : `No library entry has id "${requestedId}" and nothing similar was found. Ids are <kind>/<slug>; use summer_search_library.`,
    };
  }

  const kind = entry.kind as LibraryKind;
  const slug = entry.id.split("/").pop()!;
  const kindDir = LIBRARY_KIND_DIRS[kind] ?? `${kind}s`;
  const relPath = `library/${kindDir}/${slug}`;
  const dir = join(root, "library", kindDir, slug);
  const files = listFiles(dir);
  const related = relatedMap(entry);

  let bodyFile: string | undefined;
  let bodyTitle: string;
  let body: string;
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
    } else {
      bodyTitle = "body";
      body = `(no body file shipped for this ${kind}; the descriptor below is all there is)`;
    }
  }

  const resourceYaml = readText(join(dir, "resource.yaml"))?.replace(/\s+$/, "") ?? "(resource.yaml not found in this install)";
  const footer = feedbackFooter(entry.id, entry.content_hash);

  const sections: string[] = [header(entry, slug, related)];
  if (part === "skill" || part === "all") sections.push(`--- ${bodyTitle} ---\n${body}`);
  if (part === "resource" || part === "all") sections.push(`--- ${relPath}/resource.yaml ---\n${resourceYaml}`);
  sections.push(footer);

  const result: LibraryReadOk = {
    ok: true,
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
    text: sections.join("\n\n"),
  };
  if (bodyFile) result.body_file = bodyFile;
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
