import { closeSync, cpSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSkillRegistry, resolveSkillDir, type SkillRegistryEntry } from "../core/skills-registry.js";
import { allAgentSpecs, defaultPathContext, resolveSkillPath } from "./agent-table.js";
import { compareSemver, parseSemver, readKeptSkills, readSkillMarker, SKILL_VERSION_MARKER_FILENAME, type SkillVersionMarker } from "./version-check.js";

/**
 * After an upgrade, bring the Summer skills already installed on this
 * computer up to this CLI's version. Skills written for 3.x name 3.x tools,
 * and while their marker says 3.x the MCP server keeps the legacy toolset on
 * (legacy-toolset.ts), which gives back most of 4.0's smaller tool list.
 *
 * Only what Summer installed and nobody changed is replaced, in a skills
 * folder that carries Summer's `.summer-version` marker older than this CLI:
 * a real folder (not a link) whose `resource.yaml` says `id: skill/<name>`
 * (every Summer release ships it; other packs reuse names such as
 * `brainstorming`), with no file changed after the marker was written, and
 * not one an earlier refresh already left for that reason (the marker lists
 * them, so the protection lasts until `summer setup --force`). A copy that
 * already matches the library counts as current, not as changed. Each
 * replacement is a copy beside it and two renames, so a kill or a copy error
 * leaves the old skill in place. One process per folder (a lock file).
 * Nothing is removed. Missing library skills are added only to a folder that
 * holds nearly the whole library, so an assets-only install stays one.
 * Rule-file installs (Cline, Roo Code, old Cursor rules) keep the refresh
 * command `summer doctor` prints.
 */

const LOCK_FILE = ".summer-refresh.lock";
const STALE_LOCK_MS = 60_000;
/** Setup writes the marker right after its copy; a file changed later than this was changed by someone. */
const EDIT_GRACE_MS = 60_000;
/** A folder holding this share of the bundled library is a full install: new library skills join it. */
const FULL_INSTALL_SHARE = 0.9;
const TEMP_PREFIX = ".summer-refresh-";
const OLD_PREFIX = ".summer-old-";

export interface RefreshedFolder {
  dir: string;
  from: string;
  to: string;
  /** Skills replaced with this version's copy. */
  updated: string[];
  /** New library skills added to a full install. */
  added: string[];
  /** Summer's skills someone changed after install: left as they are. */
  kept: string[];
}

export interface RefreshFailure {
  dir: string;
  skill?: string;
  code: string;
}

export interface RefreshResult {
  refreshed: RefreshedFolder[];
  failures: RefreshFailure[];
}

/** User-scope skill folders with one folder per skill, each listed once. */
export function skillFolderLocations(): string[] {
  const ctx = defaultPathContext();
  const dirs = new Set<string>([join(ctx.home, ".summer", "skills")]);
  for (const spec of allAgentSpecs()) {
    const home = resolveSkillPath(spec, "user", ctx);
    if (home?.kind === "skill-dir") dirs.add(home.path);
  }
  return [...dirs];
}

const isPrerelease = (version: string) => /^\d+\.\d+\.\d+-/.test(version.trim());

/** Refresh when the marker is older, or a pre-release of this release (4.2.0-next.1 -> 4.2.0, never back). */
function isBehind(marker: SkillVersionMarker, cliVersion: string): boolean {
  const installed = parseSemver(marker.version);
  const current = parseSemver(cliVersion);
  if (!installed || !current) return false;
  const order = compareSemver(installed, current);
  return order < 0 || (order === 0 && isPrerelease(marker.version) && !isPrerelease(cliVersion));
}



const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));

/** Summer's own copy: a real folder (not a link) whose resource.yaml names this skill. */
function isSummersSkill(dest: string, name: string): boolean {
  try {
    if (!lstatSync(dest).isDirectory()) return false;
    const id = readFileSync(join(dest, "resource.yaml"), "utf-8").match(/^id:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
    return id === `skill/${name}`;
  } catch {
    return false;
  }
}

/** The folder, or any file in it, changed after `since` (ms); the folder's own time covers a deleted file. Links are not followed. */
function changedSince(dir: string, since: number): boolean {
  if (lstatSync(dir).mtimeMs > since) return true;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (lstatSync(path).mtimeMs > since) return true;
    if (entry.isDirectory() && changedSince(path, since)) return true;
  }
  return false;
}

/** Relative paths of every file under `dir`. */
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  );
}

/** The installed folder holds exactly the library's files with the library's bytes (a refresh a kill interrupted already wrote it). */
function sameAsLibrary(dest: string, src: string): boolean {
  try {
    const installed = filesUnder(dest).sort();
    const library = filesUnder(src).sort();
    return (
      installed.length === library.length &&
      installed.every((file, index) => file === library[index] && readFileSync(join(dest, file)).equals(readFileSync(join(src, file))))
    );
  } catch {
    return false;
  }
}

/** Copy beside, rename the old one aside, rename the new one in; the old one comes back on any error. */
function replaceSkill(dir: string, name: string, src: string): void {
  const dest = join(dir, name);
  const temp = join(dir, `${TEMP_PREFIX}${name}-${process.pid}`);
  const old = join(dir, `${OLD_PREFIX}${name}-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  try {
    cpSync(src, temp, { recursive: true });
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  const hadOld = existsSync(dest);
  if (hadOld) renameSync(dest, old);
  try {
    renameSync(temp, dest);
  } catch (error) {
    if (hadOld) renameSync(old, dest);
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  if (hadOld) rmSync(old, { recursive: true, force: true });
}

/** What a killed refresh left: half copies go, a skill renamed aside comes back. */
function recoverInterrupted(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry.startsWith(TEMP_PREFIX)) rmSync(path, { recursive: true, force: true });
    if (!entry.startsWith(OLD_PREFIX)) continue;
    const name = entry.slice(OLD_PREFIX.length).replace(/-\d+$/, "");
    if (existsSync(join(dir, name))) rmSync(path, { recursive: true, force: true });
    else renameSync(path, join(dir, name));
  }
}

/** The folder's lock, or null while another process holds a fresh one. */
function takeLock(dir: string): (() => void) | null {
  const path = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, "wx"));
      return () => rmSync(path, { force: true });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs < STALE_LOCK_MS) return null;
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function refreshFolder(
  dir: string,
  marker: SkillVersionMarker,
  cliVersion: string,
  registry: readonly SkillRegistryEntry[],
  failures: RefreshFailure[]
): RefreshedFolder | null {
  const release = takeLock(dir);
  if (!release) return null;
  try {
    recoverInterrupted(dir);
    // The marker must be writable before anything is copied, or every start would copy again.
    const markerTemp = join(dir, `${SKILL_VERSION_MARKER_FILENAME}.tmp`);
    writeFileSync(markerTemp, "", "utf-8");

    const installedAt = Date.parse(marker.installedAt);
    const editedAfter = (Number.isFinite(installedAt) ? installedAt : 0) + EDIT_GRACE_MS;
    const folder: RefreshedFolder = { dir, from: marker.version, to: cliVersion, updated: [], added: [], kept: [] };
    const keptBefore = new Set(readKeptSkills(dir));
    const owned = registry.filter((entry) => isSummersSkill(join(dir, entry.name), entry.name));
    for (const entry of owned) {
      const dest = join(dir, entry.name);
      if (sameAsLibrary(dest, resolveSkillDir(entry))) {
        folder.updated.push(entry.name);
        continue;
      }
      if (keptBefore.has(entry.name) || changedSince(dest, editedAfter)) {
        folder.kept.push(entry.name);
        continue;
      }
      try {
        replaceSkill(dir, entry.name, resolveSkillDir(entry));
        folder.updated.push(entry.name);
      } catch (error) {
        failures.push({ dir, skill: entry.name, code: errorCode(error) });
      }
    }
    const bundled = registry.filter((entry) => entry.bundled !== false && entry.status !== "deprecated");
    if (bundled.length > 0 && owned.length >= FULL_INSTALL_SHARE * bundled.length) {
      for (const entry of bundled) {
        if (existsSync(join(dir, entry.name))) continue;
        try {
          replaceSkill(dir, entry.name, resolveSkillDir(entry));
          folder.added.push(entry.name);
        } catch (error) {
          failures.push({ dir, skill: entry.name, code: errorCode(error) });
        }
      }
    }

    // Written last, through a rename: a kill before this leaves the old marker, and the next start finishes.
    const next: SkillVersionMarker = { version: cliVersion, installedAt: new Date().toISOString(), ...(folder.kept.length > 0 ? { kept: folder.kept } : {}) };
    writeFileSync(markerTemp, JSON.stringify(next, null, 2) + "\n", "utf-8");
    renameSync(markerTemp, join(dir, SKILL_VERSION_MARKER_FILENAME));
    return folder;
  } finally {
    release();
  }
}

export function refreshInstalledSkills(
  cliVersion: string,
  options: { dirs?: string[]; registry?: readonly SkillRegistryEntry[] } = {}
): RefreshResult {
  const result: RefreshResult = { refreshed: [], failures: [] };
  if (!parseSemver(cliVersion)) return result;
  for (const dir of options.dirs ?? skillFolderLocations()) {
    const marker = readSkillMarker(dir);
    if (!marker || !isBehind(marker, cliVersion)) continue;
    try {
      const folder = refreshFolder(dir, marker, cliVersion, options.registry ?? getSkillRegistry(), result.failures);
      if (folder) result.refreshed.push(folder);
    } catch (error) {
      // A folder we cannot lock or write keeps its skills and its marker; doctor still names the refresh.
      result.failures.push({ dir, code: errorCode(error) });
    }
  }
  return result;
}

const listed = (names: readonly string[]) =>
  names.length > 5 ? `${names.slice(0, 5).join(", ")} and ${names.length - 5} more` : names.join(", ");

/** The one message a person and their agent see after a refresh, or null when nothing changed. */
export function refreshNotice(refreshed: readonly RefreshedFolder[], failures: readonly RefreshFailure[] = []): string | null {
  const skills = new Set(refreshed.flatMap((folder) => [...folder.updated, ...folder.added])).size;
  const kept = [...new Set(refreshed.flatMap((folder) => folder.kept))];
  const failed = [...new Set(failures.flatMap((failure) => (failure.skill ? [failure.skill] : [])))];
  if (skills === 0 && kept.length === 0) return null;
  const changedFolders = refreshed.filter((folder) => folder.updated.length + folder.added.length > 0).length;
  const from = [...new Set(refreshed.map((folder) => folder.from))].join(", ");
  const to = refreshed[0].to;
  return [
    skills > 0 ? `Summer updated its ${skills} installed skills (${changedFolders === 1 ? "1 folder" : `${changedFolders} folders`}) from ${from} to ${to}.` : "",
    kept.length > 0
      ? `It left ${kept.length} Summer skills you changed as they are (${listed(kept)}); summer setup <agent> --force replaces them.`
      : "",
    failed.length > 0 ? `${failed.length} could not be updated (${listed(failed)}); summer setup <agent> --force retries them.` : "",
    "3.x tool names still run through summer_call; summer mcp --toolsets legacy lists them again.",
  ]
    .filter(Boolean)
    .join(" ");
}
