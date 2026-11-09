/**
 * An older `summer` first on PATH. After `npx -y summer-engine@latest setup`,
 * the person's next `summer login` runs whatever `summer` their shell finds
 * first, which can be a stale global install (3.1.0 while setup ran 4.8.0).
 * Setup names it and says how to update it.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { PACKAGE_ROOT } from "../core/package-root.js";
import { compareSemver, parseSemver } from "./version-check.js";

export interface ShadowingSummer {
  /** The `summer` the shell runs, as found on PATH. */
  path: string;
  version: string;
  /** Installed by Homebrew (its Cellar), so brew updates it. */
  homebrew: boolean;
}

export interface PathShadowDeps {
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  readFile?: (path: string) => string;
  platform?: NodeJS.Platform;
  packageRoot?: string;
}

/** The summer-engine package a `summer` launcher belongs to: up from where its link points, or the
 *  npm prefix beside a Windows `summer.cmd`. Null for any other program named summer. */
function owningPackage(bin: string, deps: Required<PathShadowDeps>): { root: string; version: string } | null {
  const candidates: string[] = [];
  let dir = dirname(deps.realpath(bin));
  for (let i = 0; i < 6; i += 1) {
    candidates.push(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  candidates.push(join(dirname(bin), "node_modules", "summer-engine"));
  for (const root of candidates) {
    const manifest = join(root, "package.json");
    if (!deps.exists(manifest)) continue;
    try {
      const pkg = JSON.parse(deps.readFile(manifest)) as { name?: string; version?: string };
      if (pkg.name === "summer-engine" && pkg.version) return { root, version: pkg.version };
    } catch {
      // not a package we can read: keep looking
    }
  }
  return null;
}

/**
 * The first `summer` on PATH that is not this package, when it is an older summer-engine.
 * npx puts its own copy (this package) first while setup runs; that copy is gone afterwards,
 * so the next one is what the person's shell runs.
 */
export function findShadowingSummer(
  runningVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  overrides: PathShadowDeps = {}
): ShadowingSummer | null {
  const deps: Required<PathShadowDeps> = {
    exists: overrides.exists ?? existsSync,
    realpath: overrides.realpath ?? ((path) => realpathSync(path)),
    readFile: overrides.readFile ?? ((path) => readFileSync(path, "utf-8")),
    platform: overrides.platform ?? process.platform,
    packageRoot: overrides.packageRoot ?? PACKAGE_ROOT,
  };
  const running = parseSemver(runningVersion);
  if (!running) return null;
  const names = deps.platform === "win32" ? ["summer.cmd", "summer.exe", "summer"] : ["summer"];
  const ours = safeRealpath(deps.packageRoot, deps);
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    const bin = names.map((name) => join(dir, name)).find((path) => deps.exists(path));
    if (!bin) continue;
    let owner: { root: string; version: string } | null;
    try {
      owner = owningPackage(bin, deps);
    } catch {
      continue;
    }
    if (owner && safeRealpath(owner.root, deps) === ours) continue;
    if (!owner) return null;
    const found = parseSemver(owner.version);
    if (!found || compareSemver(found, running) >= 0) return null;
    return { path: bin, version: owner.version, homebrew: safeRealpath(bin, deps).includes(`${sep}Cellar${sep}`) };
  }
  return null;
}

function safeRealpath(path: string, deps: Required<PathShadowDeps>): string {
  try {
    return deps.realpath(path);
  } catch {
    return path;
  }
}

/** The one warning line: which `summer` the shell runs, and the command that updates it. */
export function shadowWarning(found: ShadowingSummer, runningVersion: string): string {
  const update = found.homebrew ? "brew upgrade summerengine/tap/summer" : "npm install -g summer-engine@latest";
  return `The summer command in your shell is ${found.version} (${found.path}), older than this setup (${runningVersion}), so summer login would run the old CLI. Update it: ${update}. Until then: npx -y summer-engine@latest login`;
}
