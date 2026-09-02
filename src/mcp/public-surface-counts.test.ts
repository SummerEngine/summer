import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");

function walk(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((entry) => walk(resolve(path, entry)));
}

function countMcpTools(): number {
  const toolFiles = walk(resolve(packageRoot, "src/mcp/tools")).filter(
    (path) => path.endsWith(".ts") && !path.endsWith(".test.ts")
  );
  return toolFiles.reduce((count, path) => {
    const registrations =
      readFileSync(path, "utf8").match(/\bserver\.tool\s*\(/g) ?? [];
    return count + registrations.length;
  }, 0);
}

function countSkills(): number {
  return walk(resolve(packageRoot, "library/skills")).filter(
    (path) => basename(path) === "SKILL.md"
  ).length;
}

describe("public setup surface counts", () => {
  const currentSurfaces = [
    "README.md",
    "AGENTS.md",
    "GEMINI.md",
    "docs/DEVELOPMENT.md",
    "docs/OVERVIEW.md",
    ".opencode/INSTALL.md",
    ".opencode/plugins/summer.js",
    ".codex-plugin/plugin.json",
    "library/references/mcp-tools-reference/mcp-tools-reference.md",
  ];

  it("keeps the checked registry totals tied to source inventory", () => {
    expect(countMcpTools()).toBe(70);
    expect(countSkills()).toBe(83);
  });

  it("does not publish stale setup counts", () => {
    const text = currentSurfaces
      .map((path) => readFileSync(resolve(packageRoot, path), "utf8"))
      .join("\n");

    expect(text).not.toMatch(/\b(?:56|37)\s+(?:focused\s+)?tools\b/i);
    expect(text).not.toMatch(/\b(?:24|60)\s+(?:auto-trigger\s+)?skills\b/i);
  });

  it("keeps retained MCP count claims equal to the live registry", () => {
    const actual = countMcpTools();
    const retainedClaims = currentSurfaces.flatMap((path) => {
      const text = readFileSync(resolve(packageRoot, path), "utf8");
      const claimPatterns = [
        /\b(\d+)-tool MCP bridge\b/gi,
        /\b(\d+)\s+tools that talk\b/gi,
        /\bTool surface \((\d+)\s+tools\)/gi,
        /\bexposes (\d+)\s+focused tools\b/gi,
      ];
      return claimPatterns.flatMap((pattern) =>
        [...text.matchAll(pattern)].map((match) =>
          Number.parseInt(match[1], 10)
        )
      );
    });

    expect(retainedClaims.length).toBeGreaterThan(0);
    expect(retainedClaims).toEqual(retainedClaims.map(() => actual));
  });
});
