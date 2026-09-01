import { readFile } from "fs/promises";
import { join } from "path";

/**
 * Tracked-set rules (spec section 13). Full-project sync, single mode.
 * Hard excludes cannot be re-included; .summercloudignore can only exclude
 * further. The built-in rule set carries RULES_VERSION; manifests record the
 * rulesVersion that produced them so stale clients can operate restricted.
 */
export const RULES_VERSION = 1;

/** Directory names hard-excluded at any depth. */
const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  ".godot",
  "node_modules",
  ".next",
  ".claude",
  ".specstory",
]);

/** Root-only excluded directories. */
const EXCLUDED_ROOT_DIRS = new Set(["android"]);

/** Exact file basenames hard-excluded everywhere. */
const EXCLUDED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "project.godot.bak"]);

export function isHardExcludedDir(relPath: string, name: string): boolean {
  if (EXCLUDED_DIR_NAMES.has(name)) return true;
  if (EXCLUDED_ROOT_DIRS.has(name) && relPath === name) return true;
  // .summer/local/ is machine state; the rest of .summer/** is tracked.
  if (relPath === ".summer/local") return true;
  return false;
}

/**
 * Hard-excluded files. `siblings` is the set of basenames in the same
 * directory, used to detect Godot safe-save temps (name-XXXXXX with the base
 * file present).
 */
export function isHardExcludedFile(relPath: string, name: string, siblings: ReadonlySet<string>): boolean {
  if (EXCLUDED_FILE_NAMES.has(name)) return true;
  if (name.startsWith(".env")) return true;
  if (name.endsWith(".translation")) return true;
  if (name.endsWith(".tmp")) return true;
  if (isGodotSafeSaveTemp(name, siblings)) return true;
  return false;
}

/** Godot safe-save writes `name-XXXXXX` (six trailing random chars) next to `name`. */
export function isGodotSafeSaveTemp(name: string, siblings: ReadonlySet<string>): boolean {
  const match = /^(.+)-[A-Za-z0-9]{6}$/.exec(name);
  if (!match) return false;
  return siblings.has(match[1]);
}

/** True when a manifest key falls under the built-in hard excludes. */
export function isHardExcludedPath(path: string): boolean {
  if (path === ".summer/local" || path.startsWith(".summer/local/")) return true;
  const segments = path.split("/");
  let prefix = "";
  for (let i = 0; i < segments.length - 1; i += 1) {
    prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
    if (isHardExcludedDir(prefix, segments[i])) return true;
  }
  const name = segments[segments.length - 1];
  if (EXCLUDED_DIR_NAMES.has(name)) return true;
  return isHardExcludedFile(path, name, new Set());
}

export interface IgnoreRule {
  raw: string;
  /** Trailing slash: matches directories (and everything under them). */
  directory: boolean;
  /** Leading slash: anchored to the project root. */
  anchored: boolean;
  regex: RegExp;
}

export interface TrackedRules {
  rulesVersion: number;
  ignore: IgnoreRule[];
}

export async function loadTrackedRules(projectRoot: string): Promise<TrackedRules> {
  let raw = "";
  try {
    raw = await readFile(join(projectRoot, ".summercloudignore"), "utf8");
  } catch {
    return { rulesVersion: RULES_VERSION, ignore: [] };
  }
  return { rulesVersion: RULES_VERSION, ignore: parseIgnoreRules(raw) };
}

export function parseIgnoreRules(raw: string): IgnoreRule[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => {
      const directory = line.endsWith("/");
      let cleaned = directory ? line.slice(0, -1) : line;
      const anchored = cleaned.startsWith("/");
      if (anchored) cleaned = cleaned.slice(1);
      return { raw: cleaned, directory, anchored, regex: globToRegex(cleaned, anchored) };
    });
}

function globToRegex(pattern: string, anchored: boolean): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  // Gitignore semantics: an unanchored pattern without a slash matches at any
  // depth; a pattern containing a slash is root-relative.
  const prefix = anchored || pattern.includes("/") ? "^" : "(^|/)";
  return new RegExp(`${prefix}${out}$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function isIgnoredByRules(path: string, isDirectory: boolean, rules: TrackedRules): boolean {
  for (const rule of rules.ignore) {
    if (rule.regex.test(path)) {
      if (rule.directory && !isDirectory) continue;
      return true;
    }
    // A directory rule also excludes everything under a matching directory.
    const segments = path.split("/");
    let prefix = "";
    for (let i = 0; i < segments.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
      if (rule.regex.test(prefix)) return true;
    }
  }
  return false;
}

/**
 * Deletion semantics (spec 13): a path may be marked deleted only if it
 * matches the CURRENT tracked rules AND is absent on disk. Paths that merely
 * stopped matching rules are carried forward unchanged.
 */
export function isTrackedByCurrentRules(path: string, rules: TrackedRules): boolean {
  if (path === "summer-cloud.json") return false;
  if (isHardExcludedPath(path)) return false;
  if (isIgnoredByRules(path, false, rules)) return false;
  return true;
}
