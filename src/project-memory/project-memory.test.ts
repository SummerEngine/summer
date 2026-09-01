import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getProjectMemorySummary } from "./project-memory.js";

let tempDirs: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "summer-memory-"));
  tempDirs.push(dir);
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

describe("getProjectMemorySummary", () => {
  it("returns an absent summary when project path is unavailable", () => {
    const summary = getProjectMemorySummary(null);

    expect(summary.present).toBe(false);
    expect(summary.reason).toMatch(/Project path/);
    expect(summary.files).toEqual([]);
  });

  it("returns an absent summary when .summer does not exist", () => {
    const project = makeProject();
    const summary = getProjectMemorySummary(project);

    expect(summary.present).toBe(false);
    expect(summary.reason).toMatch(/No \.summer/);
    expect(summary.canonical.gameSoul).toBeNull();
  });

  it("summarizes canonical and structured project memory", () => {
    const project = makeProject();

    write(project, ".summer/GameSoul.md", "# Star Garden\n\nA cozy space farming game.");
    write(project, ".summer/art-bible.md", "# Art Bible\n\nPainterly nebula farms.");
    write(
      project,
      ".summer/memory/casting/voices.md",
      `---
id: casting.voice.main-cast
type: casting
priority: locked
stable: true
---

# Main Voice Cast

| Character | Provider | Voice ID | Stability |
|---|---|---|---|
| Bob | ElevenLabs | \`voice_bob\` | locked |
`
    );
    write(project, ".summer/memory/index.json", "{}");

    const summary = getProjectMemorySummary(project);

    expect(summary.present).toBe(true);
    expect(summary.canonical.gameSoul?.title).toBe("Star Garden");
    expect(summary.canonical.artBible?.kind).toBe("art");
    expect(summary.structured.present).toBe(true);
    expect(summary.structured.indexPresent).toBe(true);
    expect(summary.structured.fileCount).toBe(1);
    expect(summary.structured.lockedCount).toBe(1);
    expect(summary.structured.files[0]).toMatchObject({
      path: ".summer/memory/casting/voices.md",
      kind: "casting",
      title: "Main Voice Cast",
      locked: true,
    });
  });

  it("does not report installed project skills as game memory", () => {
    const project = makeProject();

    write(project, ".summer/GameSoul.md", "# Game\n");
    write(project, ".summer/skills/fps-controller/SKILL.md", "# Skill\n");
    write(project, ".summer/local/notes.md", "# Local\n");

    const summary = getProjectMemorySummary(project);
    const paths = summary.files.map((file) => file.path);

    expect(paths).toContain(".summer/GameSoul.md");
    expect(paths).not.toContain(".summer/skills/fps-controller/SKILL.md");
    expect(paths).not.toContain(".summer/local/notes.md");
  });
});
