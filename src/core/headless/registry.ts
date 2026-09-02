import { lstat, readFile } from "fs/promises";
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

/**
 * Reader for the headless process registry the engine maintains at
 * <editor cache dir>/summer_processes.cfg (engine ConfigFile / INI-ish format).
 *
 * Shape (contract — mirror of the worker agent's brief):
 *   [<absolute project path>]        ; section name = project path
 *   role="worker"
 *   pid=12345
 *   port=6600
 *   token="hex..."
 *   started_ts=1756700000
 *
 * This module only READS the registry. Dead-pid "pruning" is in-memory
 * filtering — the CLI never rewrites the file, because the engine/worker owns
 * it and a concurrent rewrite from the CLI could race a worker registering
 * itself.
 */

export const REGISTRY_FILENAME = "summer_processes.cfg";

/** A registry file larger than this is treated as corrupt (empty registry). */
export const MAX_REGISTRY_BYTES = 512 * 1024;

export interface WorkerRegistryEntry {
  /** Canonical absolute project path (the section name, resolved). */
  projectPath: string;
  role: string;
  pid: number;
  port: number;
  token: string;
  startedTs?: number;
}

export interface ReadRegistryOptions {
  /** Full path to summer_processes.cfg. Overrides cacheDir. */
  registryPath?: string;
  /** Editor cache dir containing the registry file. */
  cacheDir?: string;
  /** Liveness probe, injectable for tests. Defaults to kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
}

/**
 * Canonicalize a project path for registry-section matching:
 *   - resolve to absolute, then REALPATH it — the engine canonicalizes the
 *     section paths it writes (macOS: /var is a symlink to /private/var), so
 *     a resolve()-only lookup of a symlinked path would never match the
 *     engine-written section and spawn would time out with the worker alive.
 *     Non-existent paths fall back to the resolved form.
 *   - strip trailing separators
 *   - on Windows: normalize backslashes to forward slashes and lowercase
 *     (NTFS is case-insensitive; the engine may write either casing)
 * `platformName` is injectable so the Windows rules are unit-testable
 * anywhere. Used consistently for registry lookups AND single-flight keys.
 */
export function normalizeProjectPath(
  path: string,
  platformName: NodeJS.Platform = process.platform
): string {
  let normalized = resolve(path.trim());
  try {
    normalized = realpathSync(normalized);
  } catch {
    // Path does not exist (yet) — keep the resolved form.
  }
  if (platformName === "win32") {
    normalized = normalized.replace(/\\/g, "/").toLowerCase();
  }
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

import { processIsAlive } from "../util/process.js";
export { processIsAlive };

/**
 * Resolve the editor cache dir that holds summer_processes.cfg.
 *
 * The engine derives it from OS::get_cache_path() + get_godot_dir_name():
 *   macOS   ~/Library/Caches/<Name>        (platform/macos/os_macos.mm:503,561)
 *   Windows %LOCALAPPDATA%/<Name>          (platform/windows/os_windows.cpp:2688)
 *   Linux   $XDG_CACHE_HOME|~/.cache/<name> (platform/linuxbsd/os_linuxbsd.cpp:957)
 * <Name> is version.py short_name — "Summer" in shipped Summer builds
 * (verified: ~/Library/Caches/Summer holds editor_doc_cache/resthumb files),
 * the upstream name in unrebranded dev builds. We probe the Summer name first
 * and fall back to the upstream name only when the registry file actually
 * exists there.
 *
 * SUMMER_CACHE_DIR overrides everything (useful for tests and nonstandard
 * installs).
 */
export function resolveEditorCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SUMMER_CACHE_DIR?.trim();
  if (override) return override;

  const home = homedir();
  let base: string;
  let names: string[];
  switch (process.platform) {
    case "darwin":
      base = join(home, "Library", "Caches");
      names = ["Summer", "Godot"];
      break;
    case "win32":
      base = env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
      names = ["Summer", "Godot"];
      break;
    default: {
      const xdg = env.XDG_CACHE_HOME?.trim();
      base = xdg && xdg.startsWith("/") ? xdg : join(home, ".cache");
      names = ["summer", "godot"];
      break;
    }
  }

  for (const name of names) {
    if (existsSync(join(base, name, REGISTRY_FILENAME))) return join(base, name);
  }
  // Default to the Summer-branded dir even when the registry does not exist
  // yet — a spawned worker will create the file there.
  return join(base, names[0]);
}

export function registryPathFor(options: ReadRegistryOptions = {}): string {
  if (options.registryPath) return options.registryPath;
  return join(options.cacheDir ?? resolveEditorCacheDir(), REGISTRY_FILENAME);
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // The registry's string escapes are a JSON subset for the values we
    // care about (paths, roles, hex tokens). Fall back to a bare strip when
    // JSON.parse rejects an exotic escape.
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* fall through */
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function numberValue(raw: string): number | undefined {
  const value = Number(unquote(raw));
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse the registry's ConfigFile text into raw sections. Exported for tests.
 * Tolerant: comments (; or #), blank lines, quoted or bare section names,
 * `key=value` with or without spaces. Malformed lines are skipped — one bad
 * section must not hide live workers.
 */
export function parseRegistryText(
  text: string
): Array<{ section: string; values: Record<string, string> }> {
  const sections: Array<{ section: string; values: Record<string, string> }> = [];
  let current: { section: string; values: Record<string, string> } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      // Godot's ConfigFile writes a section name as "[" + name.replace("]",
      // "\\]") + "]", so a project path containing "]" arrives escaped and
      // would otherwise never match the caller's normalized path.
      const name = unquote(line.slice(1, -1).replace(/\\\]/g, "]"));
      current = { section: name, values: {} };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) current.values[key] = value;
  }
  return sections;
}

/**
 * Read the registry and return LIVE entries only (dead-pid sections are
 * pruned from the result; the file itself is never rewritten). A missing or
 * unreadable registry yields [] — same meaning as "no workers".
 */
export async function readProcessRegistry(
  options: ReadRegistryOptions = {}
): Promise<WorkerRegistryEntry[]> {
  const path = registryPathFor(options);
  const isAlive = options.isAlive ?? processIsAlive;

  let text: string;
  try {
    // Trust boundary: only a REGULAR file is accepted — a symlink planted at
    // the registry path (pointing at attacker-chosen content) is refused, as
    // is an implausibly large file. lstat does not follow symlinks.
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_REGISTRY_BYTES
    ) {
      return [];
    }
    text = await readFile(path, "utf-8");
  } catch {
    return [];
  }

  const entries: WorkerRegistryEntry[] = [];
  for (const { section, values } of parseRegistryText(text)) {
    const pid = numberValue(values.pid ?? "");
    const port = numberValue(values.port ?? "");
    const token = values.token !== undefined ? unquote(values.token) : "";
    const role = values.role !== undefined ? unquote(values.role) : "";
    if (
      !section ||
      !pid ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !port ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !token
    ) {
      continue;
    }
    if (!isAlive(pid)) continue;
    entries.push({
      projectPath: resolve(section),
      role,
      pid,
      port,
      token,
      startedTs: numberValue(values.started_ts ?? ""),
    });
  }
  return entries;
}

/** Find the live worker entry for a project (normalized path match — see
 *  normalizeProjectPath: trailing slashes stripped; on Windows additionally
 *  case-insensitive with separators normalized). */
export async function findWorkerEntry(
  projectPath: string,
  options: ReadRegistryOptions = {}
): Promise<WorkerRegistryEntry | null> {
  const target = normalizeProjectPath(projectPath);
  const entries = await readProcessRegistry(options);
  return (
    entries.find(
      (entry) =>
        normalizeProjectPath(entry.projectPath) === target &&
        entry.role === "worker"
    ) ?? null
  );
}
