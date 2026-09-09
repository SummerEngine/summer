import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getProjectMemorySummary } from "../../project-memory/project-memory.js";
import {
  findProjectRoot,
  formatMemorySummary,
  formatStatusMemoryLine,
  resolveMemoryFilePath,
} from "./memory.js";

let tempDirs: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "summer-memory-cli-"));
  tempDirs.push(dir);
  write(dir, "project.godot", "[application]\nconfig/name=\"Memory CLI\"\n");
  return dir;
}

function write(project: string, path: string, content: string): void {
  const absolutePath = join(project, ...path.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf-8");
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("memory command helpers", () => {
  it("finds a project root from a nested directory", () => {
    const project = makeProject();
    const nested = join(project, "scenes", "level01");
    mkdirSync(nested, { recursive: true });

    expect(findProjectRoot(nested)).toBe(project);
  });

  it("formats a human-readable memory summary", () => {
    const project = makeProject();
    write(project, ".summer/GameSoul.md", "# Memory CLI\n");
    write(
      project,
      ".summer/memory/casting/voices.md",
      `---
priority: locked
---

# Main Voice Cast
`
    );

    const summary = getProjectMemorySummary(project);
    const text = formatMemorySummary(project, summary);

    expect(text).toContain("Project Memory");
    expect(text).toContain(".summer/memory/casting/voices.md");
    expect(text).toContain("locked");
    expect(text).toContain("summer memory show");
  });

  it("formats a compact status line", () => {
    const project = makeProject();
    write(project, ".summer/GameSoul.md", "# Memory CLI\n");
    write(project, ".summer/memory/world/canon.md", "stable: true\n\n# Canon\n");

    expect(formatStatusMemoryLine(getProjectMemorySummary(project))).toBe(
      "Memory: 2 .summer files, 1 memory file, 1 locked"
    );
  });

  it("resolves only files inside .summer", () => {
    const project = makeProject();
    write(project, ".summer/memory/world/canon.md", "# Canon\n");

    expect(resolveMemoryFilePath(project, ".summer/memory/world/canon.md")).toBe(
      join(project, ".summer", "memory", "world", "canon.md")
    );
    expect(() => resolveMemoryFilePath(project, "../project.godot")).toThrow(
      /inside.*\.summer/
    );
  });

  it("refuses a symlink inside .summer that points outside it", () => {
    const project = makeProject();
    write(project, "secrets.md", "# not memory\n");
    write(project, ".summer/memory/world/canon.md", "# Canon\n");
    symlinkSync(join(project, "secrets.md"), join(project, ".summer", "escape.md"));

    expect(() => resolveMemoryFilePath(project, "escape.md")).toThrow(/symlink|inside.*\.summer/);
    // A link that stays inside .summer is fine.
    symlinkSync(
      join(project, ".summer", "memory", "world", "canon.md"),
      join(project, ".summer", "alias.md")
    );
    expect(resolveMemoryFilePath(project, "alias.md")).toBe(join(project, ".summer", "alias.md"));
  });

  it("accepts the Windows-style .summer\\ prefix", () => {
    const project = makeProject();
    write(project, ".summer/GameSoul.md", "# Brief\n");
    expect(resolveMemoryFilePath(project, ".summer\\GameSoul.md")).toBe(
      join(project, ".summer", "GameSoul.md")
    );
  });
});
