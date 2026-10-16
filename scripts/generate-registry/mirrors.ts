/**
 * plugins/claude/: the Claude plugin for Anthropic's plugin directory, from
 * its own small folder. The directory wants 512 files or fewer, no symlinks,
 * no lockfile and every npx launcher pinned to an exact version, so this is
 * a copy of the bundled skills, /summer:start and /summer, the icon and the license, with
 * `summer-engine@latest` pinned to this version in every text file. Its
 * manifest is generated with the others (manifests.ts, targets.ts).
 *
 * The apply step writes it and deletes files that no longer belong; --check
 * compares it byte for byte. Never edit it by hand.
 */

import fs from "node:fs";
import path from "node:path";
import { isBundledSkill, readPackageVersion, type LoadedResource } from "./index.ts";

/** The folder owned whole by this step (its manifest is a manifest target). */
export const MIRROR_ROOTS = ["plugins/claude"] as const;
export const CLAUDE_DIRECTORY_MANIFEST = "plugins/claude/.claude-plugin/plugin.json";

const TEXT = /\.(md|json|ya?ml|txt|gd|gdshader|gdshaderinc|tscn|tres|cfg|ts|js|sh)$/i;

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.name === ".DS_Store") return [];
    if (entry.isSymbolicLink()) throw new Error(`${abs} is a symlink; plugins/claude copies real files only (Anthropic's directory refuses links).`);
    return entry.isDirectory() ? filesUnder(abs) : entry.isFile() ? [abs] : [];
  });
}

const posix = (rel: string) => rel.split(path.sep).join("/");

/** Every mirrored file: repo-relative path (posix) -> content. */
export function mirrorFiles(rootDir: string, skillSlugs: string[], version: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const pin = (rel: string, content: Buffer) => (TEXT.test(rel) ? Buffer.from(content.toString("utf8").split("summer-engine@latest").join(`summer-engine@${version}`)) : content);
  for (const slug of [...skillSlugs].sort()) {
    const dir = path.join(rootDir, "library", "skills", slug);
    for (const abs of filesUnder(dir)) {
      const rel = posix(path.relative(dir, abs));
      out.set(`plugins/claude/skills/${slug}/${rel}`, pin(rel, fs.readFileSync(abs)));
    }
  }
  for (const [from, to] of [
    ["commands/start.md", "plugins/claude/commands/start.md"],
    // start.md hands over to /summer.
    ["commands/summer.md", "plugins/claude/commands/summer.md"],
    ["assets/icon.png", "plugins/claude/assets/icon.png"],
    ["LICENSE", "plugins/claude/LICENSE"],
  ] as const) {
    // A fixture root may not have them.
    if (fs.existsSync(path.join(rootDir, from))) out.set(to, pin(to, fs.readFileSync(path.join(rootDir, from))));
  }
  return [...out.keys()].sort().reduce((sorted, key) => sorted.set(key, out.get(key)!), new Map<string, Buffer>());
}

/** The mirrors of a generate result: the bundled skills at the package version. */
export function mirrorsOf(rootDir: string, resources: LoadedResource[]): Map<string, Buffer> {
  const slugs = resources.filter((resource) => resource.kind === "skill" && isBundledSkill(resource)).map((resource) => resource.slug);
  return mirrorFiles(rootDir, slugs, readPackageVersion(rootDir));
}

/** Files under the mirror roots that are not in `files` (and not the generated manifest). */
function strays(rootDir: string, files: Map<string, Buffer>): string[] {
  return MIRROR_ROOTS.flatMap((root) => filesUnder(path.join(rootDir, root)))
    .map((abs) => posix(path.relative(rootDir, abs)))
    .filter((rel) => !files.has(rel) && rel !== CLAUDE_DIRECTORY_MANIFEST);
}

export function applyMirrors(rootDir: string, files: Map<string, Buffer>): { written: number; removed: string[] } {
  let written = 0;
  for (const [rel, content] of files) {
    const abs = path.join(rootDir, rel);
    if (fs.existsSync(abs) && fs.readFileSync(abs).equals(content)) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written += 1;
  }
  const removed = strays(rootDir, files);
  for (const rel of removed) fs.rmSync(path.join(rootDir, rel));
  return { written, removed };
}

export function checkMirrors(rootDir: string, files: Map<string, Buffer>): string[] {
  const drift: string[] = [];
  for (const [rel, content] of files) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) drift.push(`${rel}: missing (run the generator's apply step)`);
    else if (!fs.readFileSync(abs).equals(content)) drift.push(`${rel}: stale copy of its library file`);
  }
  for (const rel of strays(rootDir, files)) drift.push(`${rel}: not a copy of any library file — delete it (the apply step does)`);
  return drift;
}
