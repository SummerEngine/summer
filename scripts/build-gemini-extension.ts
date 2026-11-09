#!/usr/bin/env node
/**
 * The Gemini CLI extension as one archive for a GitHub Release:
 * gemini-extension.json (without skills and settings), GEMINI.md, AGENTS.md, LICENSE and skills/<slug>/
 * for every bundled skill. `gemini extensions install
 * https://github.com/SummerEngine/summer` (and the Gemini CLI gallery)
 * installs a release's only asset when it has one. The repository keeps its
 * skills in library/skills/, and Gemini reads only <extension>/skills/<name>/SKILL.md,
 * so a plain clone of the repository gives no skills.
 *
 *   node scripts/build-gemini-extension.ts <out-dir> [<repo-root>]
 *
 * <repo-root> (default: this checkout) is the release to package, so the
 * workflow can package an older tag with today's script. Writes <out-dir>/summer/ and <out-dir>/summer-gemini-extension.tar.gz
 * (.github/workflows/gemini-extension.yml attaches it to each release).
 */
import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ARCHIVE = "summer-gemini-extension.tar.gz";

export function buildGeminiExtension(rootDir: string, outDir: string): { dir: string; archive: string; skills: string[] } {
  const manifest = JSON.parse(readFileSync(join(rootDir, "gemini-extension.json"), "utf8")) as Record<string, unknown> & { skills?: unknown[] };
  // The asset is public: only `./library/skills/<slug>/` entries, so nothing else of the checkout (.git) can get in.
  const skills = (manifest.skills ?? []).map((entry) => {
    const slug = typeof entry === "string" ? /^\.\/library\/skills\/([a-z0-9][a-z0-9-]*)\/$/.exec(entry)?.[1] : undefined;
    if (!slug) throw new Error(`gemini-extension.json: ${JSON.stringify(entry)} is not a ./library/skills/<slug>/ entry.`);
    return slug;
  });
  if (skills.length === 0) throw new Error("gemini-extension.json lists no skills; an extension without them is not worth attaching.");
  const dir = join(outDir, "summer");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  // Gemini has no `skills` key (the folder is what it reads), and the asset ships no hooks for `settings` to switch.
  const { skills: _paths, settings: _settings, ...rest } = manifest;
  writeFileSync(join(dir, "gemini-extension.json"), `${JSON.stringify(rest, null, 2)}\n`);
  const noLinks = (path: string) => {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink; the extension carries real files only.`);
    return true;
  };
  for (const file of ["GEMINI.md", "AGENTS.md", "LICENSE"]) cpSync(join(rootDir, file), join(dir, file), { filter: noLinks });
  for (const slug of skills) cpSync(join(rootDir, "library", "skills", slug), join(dir, "skills", slug), { recursive: true, filter: noLinks });
  const archive = join(outDir, ARCHIVE);
  execFileSync("tar", ["-czf", archive, "-C", outDir, "summer"]);
  return { dir, archive, skills };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("Usage: node scripts/build-gemini-extension.ts <out-dir> [<repo-root>]");
    process.exit(1);
  }
  const root = process.argv[3] ? resolve(process.argv[3]) : join(dirname(fileURLToPath(import.meta.url)), "..");
  const { archive, skills } = buildGeminiExtension(root, resolve(outDir));
  console.log(`gemini-extension: wrote ${archive} (${skills.length} skills)`);
}
