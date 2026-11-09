import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ARCHIVE, buildGeminiExtension } from "./build-gemini-extension.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "summer-gemini-extension-"));
  dirs.push(dir);
  return dir;
};

// Each test copies every bundled skill and packs them with tar: on a busy machine that takes far longer than the 20 s default.
describe("the Gemini extension release asset", () => {
  it("has every bundled skill where Gemini reads skills: skills/<name>/SKILL.md with a name and a description", () => {
    const out = scratch();
    const { dir, skills } = buildGeminiExtension(repoRoot, out);
    expect(skills.length).toBeGreaterThan(100);
    expect(readdirSync(join(dir, "skills")).sort()).toEqual([...skills].sort());
    for (const slug of skills) {
      const head = readFileSync(join(dir, "skills", slug, "SKILL.md"), "utf8").split("\n---")[0];
      expect(head, slug).toMatch(new RegExp(`^---\\nname: ${slug}\\n`));
      expect(head, slug).toMatch(/\ndescription: /);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "gemini-extension.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "summer", contextFileName: "GEMINI.md", mcpServers: { "summer-engine": expect.any(Object) } });
    expect(manifest).not.toHaveProperty("skills");
    expect(manifest).not.toHaveProperty("settings");
    for (const file of ["GEMINI.md", "AGENTS.md", "LICENSE"]) expect(existsSync(join(dir, file)), file).toBe(true);
  });

  it("packs only ./library/skills/<slug>/ entries, and refuses a manifest without skills", () => {
    for (const [skills, message] of [
      [["./library/skills/../../.git/"], /not a \.\/library\/skills\/<slug>\/ entry/],
      [["./.git/"], /not a \.\/library\/skills\/<slug>\/ entry/],
      [[], /lists no skills/],
    ] as const) {
      const root = scratch();
      for (const file of ["GEMINI.md", "AGENTS.md", "LICENSE"]) cpSync(join(repoRoot, file), join(root, file));
      writeFileSync(join(root, "gemini-extension.json"), JSON.stringify({ name: "summer", skills }));
      expect(() => buildGeminiExtension(root, scratch()), JSON.stringify(skills)).toThrow(message);
    }
  });

  it("is one archive with one top-level folder, the shape Gemini unpacks", () => {
    const out = scratch();
    buildGeminiExtension(repoRoot, out);
    const listing = execFileSync("tar", ["-tzf", join(out, ARCHIVE)], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(new Set(listing.map((entry) => entry.split("/")[0]))).toEqual(new Set(["summer"]));
    expect(listing).toContain("summer/gemini-extension.json");
    expect(listing).toContain("summer/skills/using-summer/SKILL.md");
  });
}, 120_000);
