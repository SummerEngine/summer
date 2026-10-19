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
 * `fetchPinnedTemplate` first tries the same pin as a GitHub tarball (no git,
 * so a clean Mac never sees the Command Line Tools dialog), verifies the same
 * digest from the archive, and falls back to the git path on any failure.
 *
 * A default branch is never consulted. Nothing here lists a GitHub org.
 *
 * Built-in templates (`builtin: true`) carry no pin; the CLI generates them
 * in-process. This module only identifies them.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
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

/** Seconds a network git call (`fetch`) may take before it is killed.
 *  `summer create` once hung 42 minutes inside a fetch. */
export const FETCH_TIMEOUT_ENV = "SUMMER_FETCH_TIMEOUT_S";
export const DEFAULT_FETCH_TIMEOUT_S = 120;

/** The bound in force: FETCH_TIMEOUT_ENV when it is a positive number of
 *  seconds, else the default. */
export function fetchTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FETCH_TIMEOUT_ENV]?.trim();
  if (!raw) return DEFAULT_FETCH_TIMEOUT_S;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FETCH_TIMEOUT_S;
}

/** Never prompt: a private repo (one template's is) fails at once instead of
 *  waiting on a credential prompt nobody can see. Built per call so a test can
 *  put a fake `git` on PATH. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };
}

function git(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
}

/** A git call that talks to the network: bounded by fetchTimeoutSeconds(); on
 *  expiry the child is killed (SIGTERM) and a GitTimeoutError is thrown. */
function gitNetwork(cwd: string, args: string[], repo: string): Buffer {
  const seconds = fetchTimeoutSeconds();
  try {
    return execFileSync("git", args, {
      cwd,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: seconds * 1000,
      killSignal: "SIGTERM",
    });
  } catch (err) {
    const e = err as { code?: string; killed?: boolean; signal?: string };
    if (e.code === "ETIMEDOUT" || (e.killed && e.signal === "SIGTERM")) {
      throw new GitTimeoutError(repo, seconds);
    }
    throw err;
  }
}

export class GitTimeoutError extends Error {
  constructor(
    public readonly repo: string,
    public readonly seconds: number
  ) {
    super(
      `Timed out after ${seconds}s fetching ${repo}; the git process was killed.\n` +
        "Nothing was written and the template pin is unchanged. Check that this machine can reach the repository " +
        "(network, VPN, and access — credential prompts are disabled, so a private repository fails here too), " +
        `then retry \`summer create\`. A slow network can raise the limit with ${FETCH_TIMEOUT_ENV}=<seconds>.`
    );
    this.name = "GitTimeoutError";
  }
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
      gitNetwork(opts.targetDir, ["fetch", "-q", "--depth", "1", "origin", pin.commit], pin.repo);
    } catch (err) {
      if (err instanceof GitTimeoutError) throw err;
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

// ---------- tarball (no git) ----------

/** The codeload tarball URL for a github.com pin, or null when the pin is not
 *  a GitHub repo (then only git can fetch it). */
export function githubTarballUrl(pin: TemplatePin): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(pin.repo);
  if (!m || !/^[0-9a-f]{40}$/.test(pin.commit)) return null;
  return `https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/${pin.commit}`;
}

export interface FetchPinnedOptions extends MaterializeOptions {
  /** The HTTP GET. Default: global fetch. Tests inject one. */
  fetchTarball?: (url: string, signal: AbortSignal) => Promise<Response>;
  /** Tarball URL for a pin, null for git only. Default: githubTarballUrl. Tests
   *  override it so a local (git-fetchable) pin can also take the tarball path. */
  tarballUrl?: (pin: TemplatePin) => string | null;
}

/**
 * Same contract as materializePinnedTemplate, without git when it can: a
 * github.com pin is downloaded as the codeload tarball of exactly `commit`
 * into a hidden sibling of `targetDir`, the tree digest is recomputed from the
 * archive (same formula, same strict compare), and only a match is renamed
 * into place. Any tarball failure removes the staging dir and falls back to
 * the git path, so a mismatch still ends in git's own strict check.
 * keepGit goes straight to git (a tarball has no .git).
 */
export async function fetchPinnedTemplate(
  entry: TemplateEntry,
  opts: FetchPinnedOptions
): Promise<MaterializedTemplate> {
  const pin = entry.pin;
  if (!pin) throw new Error(`${entry.id} is a built-in template and has no pin to materialize.`);
  if (existsSync(opts.targetDir)) throw new Error(`Directory already exists: ${opts.targetDir}`);
  const url = opts.keepGit ? null : (opts.tarballUrl ?? githubTarballUrl)(pin);
  if (!url) return materializePinnedTemplate(entry, opts);
  const log = opts.log ?? (() => {});

  const target = resolve(opts.targetDir);
  const staging = join(dirname(target), `.${basename(target)}.summer-download-${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(staging);
    log(`Downloading ${pin.repo} at ${pin.commit.slice(0, 12)} ...`);
    const fetcher = opts.fetchTarball ?? ((u: string, signal: AbortSignal) => fetch(u, { signal }));
    const actual = await downloadTree(url, staging, fetcher);
    if (actual !== pin.tree_digest) {
      throw new Error(`tree digest mismatch: archive ${actual.slice(0, 12)}, pin ${pin.tree_digest.slice(0, 12)}`);
    }
    log(`Verified tree digest ${actual.slice(0, 12)}`);
    if (existsSync(target)) throw new Error(`Directory already exists: ${opts.targetDir}`);
    renameSync(staging, target);
    return { commit: pin.commit, tree_digest: pin.tree_digest };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    const why = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
    log(`Tarball download failed (${why}); falling back to git.`);
    return materializePinnedTemplate(entry, opts);
  }
}

/** Download, gunzip and unpack a GitHub tarball into `staging` as a stream.
 *  fetchTimeoutSeconds() bounds each wait for bytes, not the whole download:
 *  a big template on a slow link keeps going while bytes arrive. Returns the
 *  tree digest of the archive. */
async function downloadTree(
  url: string,
  staging: string,
  fetcher: (url: string, signal: AbortSignal) => Promise<Response>
): Promise<string> {
  const seconds = fetchTimeoutSeconds();
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), seconds * 1000);
  const stillGoing = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), seconds * 1000);
  };
  const gunzip = createGunzip();
  try {
    const res = await fetcher(url, ctrl.signal);
    if (res.status !== 200 || !res.body) throw new Error(`HTTP ${res.status}`);
    const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
    body.on("data", stillGoing);
    // Errors on either side end the gunzip stream early; extractTar then fails.
    pipeline(body, gunzip, () => {});
    return await extractTar(gunzip, staging);
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`no data for ${seconds}s`);
    throw err;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    gunzip.destroy();
  }
}

/** Reads exact byte counts from a stream of chunks; one file at a time is the
 *  most it ever holds. */
function byteReader(source: AsyncIterable<Buffer>): (n: number) => Promise<Buffer> {
  const it = source[Symbol.asyncIterator]();
  let parts: Buffer[] = [];
  let have = 0;
  return async (n) => {
    if (n === 0) return Buffer.alloc(0);
    while (have < n) {
      const r = await it.next();
      if (r.done) throw new Error("archive ended early");
      parts.push(r.value);
      have += r.value.length;
    }
    const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
    const rest = all.subarray(n);
    parts = rest.length ? [rest] : [];
    have = rest.length;
    return all.subarray(0, n);
  };
}

function cstr(b: Buffer): Buffer {
  const i = b.indexOf(0);
  return i < 0 ? b : b.subarray(0, i);
}

/** A tar numeric field: octal text, or base-256 when the high bit is set. */
function tarNumber(field: Buffer): number {
  if (field[0] & 0x80) {
    if (field[0] === 0xff) throw new Error("negative number in tar header");
    let n = field[0] & 0x7f;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    if (!Number.isSafeInteger(n)) throw new Error("number too large in tar header");
    return n;
  }
  const s = cstr(field).toString("latin1").trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error(`bad number in tar header: ${JSON.stringify(s)}`);
  return parseInt(s, 8);
}

/** pax records: "<len> <key>=<value>\n", values kept as bytes. */
function parsePax(body: Buffer, into: Map<string, Buffer>): void {
  let pos = 0;
  while (pos < body.length) {
    const sp = body.indexOf(0x20, pos);
    const len = sp < 0 ? NaN : Number(body.subarray(pos, sp).toString("latin1"));
    if (!Number.isSafeInteger(len) || pos + len > body.length || sp >= pos + len - 1) {
      throw new Error("bad pax header");
    }
    const rec = body.subarray(sp + 1, pos + len - 1);
    const eq = rec.indexOf(0x3d);
    if (eq < 0) throw new Error("bad pax header");
    into.set(rec.subarray(0, eq).toString("utf8"), rec.subarray(eq + 1));
    pos += len;
  }
}

/** git's blob object id: sha1("blob <size>\0" + bytes). */
function blobId(data: Buffer): string {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

const C_ESCAPES: Record<number, string> = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 0x22: '"', 0x5c: "\\" };

/** A path as `git ls-tree` prints it by default (core.quotePath=true): C-quoted
 *  when it has a control byte, `"`, `\`, DEL or any byte >= 0x80. */
function quoteGitPath(path: Buffer): Buffer {
  if (!path.some((b) => b < 0x20 || b === 0x22 || b === 0x5c || b >= 0x7f)) return path;
  let out = '"';
  for (const b of path) {
    if (C_ESCAPES[b]) out += "\\" + C_ESCAPES[b];
    else if (b < 0x20 || b >= 0x7f) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return Buffer.from(out + '"', "latin1");
}

/**
 * Unpack a git-archive tar (what codeload serves) into `staging` and return
 * the documented tree digest of its contents. The top-level `<repo>-<sha>/`
 * directory is stripped. Anything unexpected throws: entry types other than
 * file/dir/symlink, absolute or `..` paths, a second top-level directory, a
 * path through a symlink, or a duplicate path. Nothing is written outside
 * `staging`.
 */
async function extractTar(source: AsyncIterable<Buffer>, staging: string): Promise<string> {
  const read = byteReader(source);
  const readPadded = async (size: number) => {
    const data = await read(size);
    await read((512 - (size % 512)) % 512);
    return data;
  };
  const lines: { path: Buffer; oid: string }[] = [];
  const realDirs = new Set<string>([staging]);
  // Create each missing directory under staging; refuse to pass through a
  // symlink or a file (lstat asks the filesystem, so case folding is covered).
  const ensureDir = (parts: string[]) => {
    let p = staging;
    for (const part of parts) {
      p = join(p, part);
      if (realDirs.has(p)) continue;
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) mkdirSync(p);
      else if (!st.isDirectory()) throw new Error(`archive path passes through a non-directory: ${parts.join("/")}`);
      realDirs.add(p);
    }
  };

  let root: Buffer | null = null;
  let pax = new Map<string, Buffer>();
  let longName: Buffer | null = null;
  let longLink: Buffer | null = null;
  for (;;) {
    const h = await read(512);
    if (h.every((b) => b === 0)) {
      if (!(await read(512)).every((b) => b === 0)) throw new Error("bad tar end marker");
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== tarNumber(h.subarray(148, 156))) throw new Error("bad tar header checksum");

    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    let size = tarNumber(h.subarray(124, 136));
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      const body = await readPadded(size);
      if (type === "x") parsePax(body, pax);
      else if (type === "L") longName = cstr(body);
      else if (type === "K") longLink = cstr(body);
      continue; // "g": GitHub puts the commit id there; nothing to apply
    }

    const ustar = h.subarray(257, 263).toString("latin1") === "ustar\0";
    const prefix = ustar ? cstr(h.subarray(345, 500)) : Buffer.alloc(0);
    const shortName = cstr(h.subarray(0, 100));
    const name =
      pax.get("path") ?? longName ?? (prefix.length ? Buffer.concat([prefix, Buffer.from("/"), shortName]) : shortName);
    const link = pax.get("linkpath") ?? longLink ?? cstr(h.subarray(157, 257));
    const paxSize = pax.get("size");
    if (paxSize) {
      size = Number(paxSize.toString("latin1"));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("bad pax size");
    }
    pax = new Map();
    longName = longLink = null;

    // Strip the single top-level `<repo>-<sha>/` directory.
    const slash = name.indexOf(0x2f);
    const top = slash < 0 ? name : name.subarray(0, slash);
    if (root === null) root = top;
    if (!top.equals(root) || top.length === 0) throw new Error("archive is not a single top-level directory");
    let rel = slash < 0 ? Buffer.alloc(0) : name.subarray(slash + 1);
    while (rel.length && rel[rel.length - 1] === 0x2f) rel = rel.subarray(0, rel.length - 1);
    const parts = rel.length ? rel.toString("utf8").split("/") : [];
    for (const part of parts) {
      if (part === "" || part === "." || part === ".." || (process.platform === "win32" && /[\\:]/.test(part))) {
        throw new Error(`unsafe path in archive: ${JSON.stringify(rel.toString("utf8"))}`);
      }
    }
    if (parts.length === 0 && type !== "5") throw new Error("file outside the archive's top-level directory");
    const dest = join(staging, ...parts);

    if (type === "0") {
      const data = await readPadded(size);
      ensureDir(parts.slice(0, -1));
      const mode = tarNumber(h.subarray(100, 108)) & 0o111 ? 0o755 : 0o644;
      writeFileSync(dest, data, { flag: "wx", mode }); // wx: never follows or overwrites
      lines.push({ path: rel, oid: blobId(data) });
    } else if (type === "5") {
      await readPadded(size);
      ensureDir(parts);
    } else if (type === "2") {
      await readPadded(size);
      ensureDir(parts.slice(0, -1));
      symlinkSync(link.toString("utf8"), dest);
      lines.push({ path: rel, oid: blobId(link) });
    } else {
      throw new Error(`unsupported tar entry type ${JSON.stringify(type)}`);
    }
  }

  // Bytewise path order equals `git ls-tree -r` order.
  lines.sort((a, b) => Buffer.compare(a.path, b.path));
  const hash = createHash("sha256");
  for (const l of lines) hash.update(`${l.oid} `).update(quoteGitPath(l.path)).update("\n");
  return hash.digest("hex");
}
