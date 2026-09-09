/**
 * Public surface counts — derived, never pinned.
 *
 * registry/generated/counts.json is the single source for "how many tools /
 * skills does Summer ship". This test asserts that the two live inventories
 * agree with it, and that the hand-written surfaces the generate-registry
 * count-claims guard does NOT scan carry no contradicting numeric claim.
 *
 * README.md / AGENTS.md / GEMINI.md are deliberately excluded here: the
 * generate-registry --check step already fails on a stale "N tools" / "N
 * skills" claim in those files (scripts/generate-registry/count-claims.ts).
 * Generated manifests stamp the count from counts.json at generation time and
 * are covered by the drift check. Nothing in this file is a literal count.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COUNT_CLAIM_FILES } from "../../scripts/generate-registry/count-claims.ts";
import { createMcpServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");

interface Counts {
  byKind: Record<string, number>;
  total: number;
}

const counts = JSON.parse(
  readFileSync(join(packageRoot, "registry/generated/counts.json"), "utf8")
) as Counts;

function countInstalledSkills(): number {
  const dir = join(packageRoot, "library/skills");
  return readdirSync(dir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md"))
  ).length;
}

/**
 * Hand-maintained surfaces that mention the tool/skill surface and are not
 * scanned by the count-claims guard. Same claim shape as that guard
 * ("70 tools", "70-tool", "3 skills") so a number here either equals
 * counts.json or the file must phrase around it.
 */
const UNGUARDED_SURFACES = [
  "docs/DEVELOPMENT.md",
  "docs/OVERVIEW.md",
  ".opencode/INSTALL.md",
  ".opencode/plugins/summer.js",
  ".codex-plugin/plugin.json",
  "library/references/mcp-tools-reference/mcp-tools-reference.md",
].filter((path) => !COUNT_CLAIM_FILES.includes(path));

const CLAIM_PATTERN = /\b(\d+)[ -](tools?|skills?)\b/g;

describe("repo-lint: public surface counts derive from registry/generated/counts.json", () => {
  it("counts.json is internally consistent", () => {
    const sum = Object.values(counts.byKind).reduce((a, b) => a + b, 0);
    expect(sum).toBe(counts.total);
    expect(counts.byKind.tool).toBeGreaterThan(0);
    expect(counts.byKind.skill).toBeGreaterThan(0);
  });

  it("live MCP registration count equals counts.tools", () => {
    const { getRegisteredToolCount } = createMcpServer();
    expect(getRegisteredToolCount()).toBe(counts.byKind.tool);
  });

  it("library/skills directory count equals counts.skills", () => {
    expect(countInstalledSkills()).toBe(counts.byKind.skill);
  });

  it("numeric claims on unguarded surfaces match counts.json", () => {
    const mismatches: string[] = [];
    let claims = 0;
    for (const relPath of UNGUARDED_SURFACES) {
      const abs = join(packageRoot, relPath);
      if (!existsSync(abs)) continue;
      const lines = readFileSync(abs, "utf8").split("\n");
      lines.forEach((text, idx) => {
        for (const match of text.matchAll(CLAIM_PATTERN)) {
          claims++;
          const found = Number(match[1]);
          const expected = match[2].startsWith("tool")
            ? counts.byKind.tool
            : counts.byKind.skill;
          if (found !== expected) {
            mismatches.push(
              `${relPath}:${idx + 1} "${match[0]}" says ${found}, counts.json has ${expected}`
            );
          }
        }
      });
    }
    // At least one retained claim must exist, or the check is checking nothing.
    expect(claims).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });
});
