/**
 * vitest globalSetup: snapshot the REAL ~/.summer before the suite and compare
 * after. Runs in the main vitest process, where HOME is still the real one
 * (fake-home.ts only rewrites HOME inside worker processes).
 *
 * Any created/deleted entry, or any changed file, fails the run and names the
 * paths — that is a test reaching past the fake HOME. Files a real concurrent
 * process legitimately rewrites on this machine (the desktop engine or a live
 * MCP server refreshing a session, appending its log) are reported as a
 * warning instead of a failure, so the guard stays honest without going red
 * because Summer was open while the tests ran.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

/** Rewritten by the running engine / a live MCP server, never by tests. */
const LIVE_PROCESS_FILES = new Set(["mcp.log", "user.json", "auth-token", "credential-metadata.json", "api-token", "api-port"]);

/**
 * The running engine heartbeats into ~/.summer/instances/<instance-id>.json
 * for as long as it is open, so those files change on every run that overlaps
 * an open editor. Tests never write there (they resolve the store through the
 * fake HOME), so a changed heartbeat is a warning, like the other live files.
 */
export function isLiveProcessFile(path: string, separator: string = sep): boolean {
  const normalized = separator === "/" ? path : path.split(separator).join("/");
  return LIVE_PROCESS_FILES.has(normalized) || /^instances\/[^/]+\.json$/.test(normalized);
}

type Snapshot = Map<string, string>;

function walk(root: string, dir: string, out: Snapshot): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue;
    }
    const rel = relative(root, path);
    if (info.isDirectory()) {
      out.set(rel + "/", "dir");
      walk(root, path, out);
    } else {
      out.set(rel, `${info.size}:${info.mtimeMs}`);
    }
  }
}

function snapshot(root: string): Snapshot {
  const out: Snapshot = new Map();
  walk(root, root, out);
  return out;
}

export default function setup(): () => void {
  const real = join(homedir(), ".summer");
  const before = snapshot(real);
  return () => {
    const after = snapshot(real);
    const failures: string[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const [path, stamp] of after) {
      seen.add(path);
      const previous = before.get(path);
      if (previous === undefined) {
        if (isLiveProcessFile(path)) warnings.push(`created  ${path} (a live engine/MCP process, not a test, is expected to write this)`);
        else failures.push(`created  ${path}`);
      } else if (previous !== stamp) {
        if (isLiveProcessFile(path)) warnings.push(`changed  ${path} (a live engine/MCP process, not a test, is expected to write this)`);
        else failures.push(`changed  ${path}`);
      }
    }
    for (const path of before.keys()) {
      if (seen.has(path)) continue;
      if (isLiveProcessFile(path)) warnings.push(`deleted  ${path} (a live engine/MCP process, not a test, is expected to remove this)`);
      else failures.push(`deleted  ${path}`);
    }
    if (warnings.length) {
      console.warn(`[real-summer-dir-guard] ${real} saw writes to live-process files during the run:\n  ${warnings.join("\n  ")}`);
    }
    if (failures.length) {
      throw new Error(
        `[real-summer-dir-guard] the REAL ${real} changed during the test run — some test reached past the fake HOME:\n  ${failures.join("\n  ")}\n` +
          "Tests must resolve the store through the fake HOME (src/test-helpers/fake-home.ts) or setSummerDirForTests(<temp dir>)."
      );
    }
  };
}
