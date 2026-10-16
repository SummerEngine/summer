#!/usr/bin/env node
/**
 * The Gemini CLI extension as one archive for a GitHub Release:
 * gemini-extension.json, GEMINI.md, AGENTS.md, LICENSE and skills/<slug>/
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
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ARCHIVE = "summer-gemini-extension.tar.gz";

export function buildGeminiExtension(rootDir: string, outDir: string): { dir: string; archive: string; skills: string[] } {
  const manifest = JSON.parse(readFileSync(join(rootDir, "gemini-extension.json"), "utf8")) as Record<string, unknown> & { skills?: string[] };
  const skills = (manifest.skills ?? []).map((entry) => entry.replace(/^\.\/library\/skills\//, "").replace(/\/$/, ""));
  const dir = join(outDir, "summer");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  // Gemini has no `skills` manifest key; the folder is what it reads.
  const { skills: _paths, ...rest } = manifest;
  writeFileSync(join(dir, "gemini-extension.json"), `${JSON.stringify(rest, null, 2)}\n`);
  for (const file of ["GEMINI.md", "AGENTS.md", "LICENSE"]) cpSync(join(rootDir, file), join(dir, file));
  for (const slug of skills) cpSync(join(rootDir, "library", "skills", slug), join(dir, "skills", slug), { recursive: true });
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
