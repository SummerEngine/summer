/**
 * Template resolution — CONTRACT.md §7 ("Templates: pinned, always").
 *
 * `summer create <slug>` resolves a template ONLY through its library pin
 * manifest (`library/templates/<slug>/resource.yaml`), compiled by
 * `npm run generate:registry` into `registry/generated/templates-registry.json`
 * (same pattern as skills-registry.json). This module:
 *
 *   1. loads that generated file relative to the package root,
 *   2. resolves a user query by id, slug, alias, or unambiguous prefix,
 *   3. materializes a pinned template: fetch exactly `commit` from `repo`,
 *      recompute `tree_digest` with the documented formula and REFUSE on any
 *      mismatch, then check out the pinned tree (detached unless keepGit).
 *
 * A default branch is never consulted. Nothing here lists a GitHub org.
 *
 * Built-in templates (`builtin: true`) carry no pin; the CLI generates them
 * in-process. This module only identifies them.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./package-root.js";

export type TemplateStatus = "stable" | "preview" | "deprecated";

export interface TemplatePin {
  /** Clone URL of the satellite repo. */
  repo: string;
  /** Exact 40-hex commit. The only thing ever checked out. */
  commit: string;
  /** sha256 of `git ls-tree -r <commit> --format='%(objectname) %(path)'`. */
  tree_digest: string;
  /** Informational only — never resolved at runtime. */
  default_branch?: string;
}

export interface TemplateEntry {
  /** Library id, e.g. "template/2d-platformer". */
  id: string;
  /** Library slug (directory name), e.g. "2d-platformer". */
  slug: string;
  version: string;
  summary: string;
  status: TemplateStatus;
  /** Legacy names that still resolve, e.g. "template-2d-platformer". */
  aliases: string[];
  systems: string[];
  do_not_use_when: string[];
  /** Package-root-relative manifest dir, e.g. "library/templates/2d-platformer/". */
  path: string;
  /** Generated in-process by the CLI; carries no pin. */
  builtin: boolean;
  /** Present iff `builtin` is false. */
  pin: TemplatePin | null;
}

export type TemplateResolution =
  | { kind: "match"; entry: TemplateEntry; via: "id" | "slug" | "alias" | "prefix" }
  | { kind: "ambiguous"; candidates: TemplateEntry[] }
  | { kind: "none" };

const REGISTRY_RELPATH = join("registry", "generated", "templates-registry.json");

let cache: TemplateEntry[] | null = null;

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function isStatus(value: unknown): value is TemplateStatus {
  return value === "stable" || value === "preview" || value === "deprecated";
}

/** Normalize one raw generated entry; returns null when it is not usable. */
export function normalizeTemplateEntry(raw: unknown): TemplateEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.slug !== "string" || typeof r.version !== "string") return null;
  const builtin = r.builtin === true;
  let pin: TemplatePin | null = null;
  if (!builtin) {
    const p = r.pin;
    if (typeof p !== "object" || p === null) return null;
    const pr = p as Record<string, unknown>;
    if (typeof pr.repo !== "string" || typeof pr.commit !== "string" || typeof pr.tree_digest !== "string") {
      return null;
    }
    pin = {
      repo: pr.repo,
      commit: pr.commit,
      tree_digest: pr.tree_digest,
      ...(typeof pr.default_branch === "string" ? { default_branch: pr.default_branch } : {}),
    };
  }
  return {
    id: r.id,
    slug: r.slug,
    version: r.version,
    summary: typeof r.summary === "string" ? r.summary : "",
    status: isStatus(r.status) ? r.status : "stable",
    aliases: strList(r.aliases),
    systems: strList(r.systems),
    do_not_use_when: strList(r.do_not_use_when),
    path: typeof r.path === "string" ? r.path : `library/templates/${r.slug}/`,
    builtin,
    pin,
  };
}

/**
 * Load the generated template registry (cached after first read).
 * Throws if the file is missing or unparsable — the npm package always ships
 * it, so a failure here means a broken build, not user error.
 */
export function getTemplateRegistry(): readonly TemplateEntry[] {
  if (cache) return cache;
  const file = join(PACKAGE_ROOT, REGISTRY_RELPATH);
  const json = JSON.parse(readFileSync(file, "utf-8")) as { templates?: unknown[] };
  const raw = Array.isArray(json.templates) ? json.templates : [];
  cache = raw.map(normalizeTemplateEntry).filter((e): e is TemplateEntry => e !== null);
  return cache;
}

/**
 * Resolve a user-supplied template name. Exact matches win in order
 * id > slug > alias; otherwise a prefix of a slug or alias must identify
 * exactly one template.
 */
export function resolveTemplate(query: string, entries: readonly TemplateEntry[]): TemplateResolution {
  const q = query.trim();
  if (q === "") return { kind: "none" };

  const byId = entries.find((e) => e.id === q);
  if (byId) return { kind: "match", entry: byId, via: "id" };

  const bySlug = entries.find((e) => e.slug === q);
  if (bySlug) return { kind: "match", entry: bySlug, via: "slug" };

  const byAlias = entries.find((e) => e.aliases.includes(q));
  if (byAlias) return { kind: "match", entry: byAlias, via: "alias" };

  const byPrefix = entries.filter(
    (e) => e.slug.startsWith(q) || e.aliases.some((a) => a.startsWith(q))
  );
  if (byPrefix.length === 1) return { kind: "match", entry: byPrefix[0], via: "prefix" };
  if (byPrefix.length > 1) return { kind: "ambiguous", candidates: byPrefix };
  return { kind: "none" };
}

// ---------- git ----------

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };

function git(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
}

function gitErrorText(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e.stderr ? e.stderr.toString().trim() : "";
  return stderr || e.message || String(err);
}

/**
 * The documented tree digest (library/templates/README.md):
 * sha256 over the exact bytes of
 *   git ls-tree -r <commit> --format='%(objectname) %(path)'
 * Requires git >= 2.36 (ls-tree --format).
 */
export function computeTreeDigest(gitDir: string, commit: string): string {
  const out = git(gitDir, ["ls-tree", "-r", commit, "--format=%(objectname) %(path)"]);
  return createHash("sha256").update(out).digest("hex");
}

export class TemplateDigestMismatchError extends Error {
  constructor(
    public readonly entry: TemplateEntry,
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(
      `Refusing to create project: tree digest mismatch for ${entry.id} at ${entry.pin?.commit ?? "?"}.\n` +
        `  expected ${expected}\n` +
        `  actual   ${actual}\n` +
        "The pinned commit does not contain the reviewed tree. Nothing was written. " +
        "Re-pin the template deliberately (library/templates/README.md) instead of trusting this checkout."
    );
    this.name = "TemplateDigestMismatchError";
  }
}

export interface MaterializeOptions {
  /** Where to put the project. Must not already exist. */
  targetDir: string;
  /** Keep the fetched .git (detached at the pinned commit). Default: remove it. */
  keepGit?: boolean;
  /** Progress lines. */
  log?: (line: string) => void;
}

export interface MaterializedTemplate {
  commit: string;
  tree_digest: string;
}

/**
 * Fetch exactly the pinned commit into `targetDir`, verify the tree digest,
 * then check the tree out. On ANY failure the target directory is removed so
 * a half-fetched template never looks like a project.
 */
export function materializePinnedTemplate(
  entry: TemplateEntry,
  opts: MaterializeOptions
): MaterializedTemplate {
  const pin = entry.pin;
  if (!pin) throw new Error(`${entry.id} is a built-in template and has no pin to materialize.`);
  if (existsSync(opts.targetDir)) throw new Error(`Directory already exists: ${opts.targetDir}`);
  const log = opts.log ?? (() => {});

  mkdirSync(opts.targetDir, { recursive: true });
  const cleanup = () => rmSync(opts.targetDir, { recursive: true, force: true });

  try {
    git(opts.targetDir, ["init", "-q"]);
    git(opts.targetDir, ["remote", "add", "origin", pin.repo]);
    log(`Fetching ${pin.repo} at ${pin.commit.slice(0, 12)} ...`);
    try {
      git(opts.targetDir, ["fetch", "-q", "--depth", "1", "origin", pin.commit]);
    } catch (err) {
      throw new Error(
        `Could not fetch ${pin.repo} at ${pin.commit}.\n  ${gitErrorText(err)}\n` +
          "Either the repository is unreachable/private from this machine, git is missing, " +
          "or upstream history was rewritten so the pinned commit no longer exists. " +
          "The pin only moves through a reviewed change to library/templates/."
      );
    }

    const actual = computeTreeDigest(opts.targetDir, pin.commit);
    if (actual !== pin.tree_digest) throw new TemplateDigestMismatchError(entry, pin.tree_digest, actual);
    log(`Verified tree digest ${actual.slice(0, 12)}`);

    git(opts.targetDir, ["checkout", "-q", pin.commit]);
  } catch (err) {
    cleanup();
    throw err;
  }

  if (!opts.keepGit) rmSync(join(opts.targetDir, ".git"), { recursive: true, force: true });
  return { commit: pin.commit, tree_digest: pin.tree_digest };
}
