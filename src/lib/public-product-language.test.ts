import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_ROOTS = [
  "README.md",
  "AGENTS.md",
  "GEMINI.md",
  "docs",
  "references",
  "skills",
  "tests/specs",
  ".claude-plugin",
  ".codex-plugin",
  ".cursor-plugin",
] as const;
const TEXT_EXTENSIONS = new Set([".md", ".json", ".ts"]);

async function publicTextFiles(path: string): Promise<string[]> {
  const absolute = join(ROOT, path);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return [absolute];
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...(await publicTextFiles(relative(ROOT, child))));
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) files.push(child);
  }
  return files;
}

describe("Summer-first public product language", () => {
  it("does not regress to the stale fixed-4.5 or mirror copy", async () => {
    const files = (
      await Promise.all(PUBLIC_ROOTS.map((path) => publicTextFiles(path)))
    ).flat();
    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (/Godot 4\.5/i.test(text)) violations.push(`${relative(ROOT, file)}: fixed 4.5`);
      if (/Engine mirror only/i.test(text)) violations.push(`${relative(ROOT, file)}: false mirror`);
      if (/config\/features=PackedStringArray\("4\.5"\)/.test(text)) {
        violations.push(`${relative(ROOT, file)}: stale project marker`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps version policy in the technical compatibility note", async () => {
    const note = await readFile(
      join(ROOT, "references/godot-version.md"),
      "utf8"
    );
    expect(note).toContain("Current Summer Engine base: **4.6.1**");
    expect(note).toContain("Planned next base: **4.7.1**");
    expect(note).toContain("follows upstream Godot continuously");
    expect(note).toContain("Summer Engine is its own product and SDK");
  });

  it("keeps current distribution availability explicit", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("macOS on Apple silicon and Windows");
    expect(readme).toMatch(/planned\s+targets, not shipping promises/);
    expect(readme).toContain("no supported public Linux installer");
  });

  it("keeps the public MCP total aligned with registered source tools", async () => {
    const toolsDir = join(ROOT, "src/mcp/tools");
    const toolFiles = (await readdir(toolsDir))
      .filter((name) => name.endsWith("-tools.ts") && !name.endsWith(".test.ts"));
    let registered = 0;
    for (const file of toolFiles) {
      const source = await readFile(join(toolsDir, file), "utf8");
      registered += source.match(/\bserver\.tool\(/g)?.length ?? 0;
    }
    expect(registered).toBe(62);

    for (const path of [
      "README.md",
      "AGENTS.md",
      "GEMINI.md",
      "references/mcp-tools-reference.md",
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
    ]) {
      const text = await readFile(join(ROOT, path), "utf8");
      expect(text, path).toMatch(/\b62(?: tools|-tool)/);
      expect(text, path).not.toMatch(/\b(?:56|60)(?: tools|-tool)/);
    }
  });
});
