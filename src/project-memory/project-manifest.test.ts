import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROJECT_MANIFEST_RELPATH,
  projectManifestPath,
  readProjectManifest,
  writeProjectManifest,
} from "./project-manifest.js";

let dir = "";
const fixedNow = () => new Date("2026-09-02T12:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "summer-manifest-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe(".summer/project.json", () => {
  it("lives at the contract path", () => {
    expect(PROJECT_MANIFEST_RELPATH).toBe(".summer/project.json");
    expect(projectManifestPath("/p")).toBe(join("/p", ".summer", "project.json"));
  });

  it("writes a fresh manifest for a pinned template", () => {
    const written = writeProjectManifest(dir, {
      template: { id: "template/2d-platformer", version: "1.0.0", repo: "https://x/y", commit: "a".repeat(40), tree_digest: "b".repeat(64) },
      toolkit_version: "2.8.2",
      now: fixedNow,
    });
    const onDisk = JSON.parse(readFileSync(projectManifestPath(dir), "utf8"));
    expect(onDisk).toEqual(written);
    expect(onDisk).toEqual({
      template: { id: "template/2d-platformer", version: "1.0.0", repo: "https://x/y", commit: "a".repeat(40), tree_digest: "b".repeat(64) },
      toolkit_version: "2.8.2",
      created_at: "2026-09-02T12:00:00.000Z",
    });
  });

  it("writes a builtin record without pin fields", () => {
    writeProjectManifest(dir, { template: { id: "template/empty", version: "1.1.0", builtin: true }, toolkit_version: "2.8.2" });
    expect(readProjectManifest(dir)?.template).toEqual({ id: "template/empty", version: "1.1.0", builtin: true });
  });

  it("records engine_version when given and keeps it across a patch without one", () => {
    const template = { id: "template/empty", version: "1.1.0", builtin: true } as const;
    writeProjectManifest(dir, { template, toolkit_version: "2.8.2", engine_version: "4.6.1.summer.7" });
    expect(readProjectManifest(dir)?.engine_version).toBe("4.6.1.summer.7");
    writeProjectManifest(dir, { template, toolkit_version: "2.8.3" });
    expect(readProjectManifest(dir)).toMatchObject({ toolkit_version: "2.8.3", engine_version: "4.6.1.summer.7" });
  });

  it("merges into an existing manifest, preserving foreign keys and created_at", () => {
    mkdirSync(join(dir, ".summer"));
    writeFileSync(
      projectManifestPath(dir),
      JSON.stringify({ engine: { version: "4.6.1" }, collections: ["collection/x"], created_at: "2020-01-01T00:00:00.000Z", toolkit_version: "old" })
    );
    const merged = writeProjectManifest(dir, {
      template: { id: "template/empty", version: "1.1.0", builtin: true },
      toolkit_version: "2.8.2",
      now: fixedNow,
    });
    expect(merged).toEqual({
      engine: { version: "4.6.1" },
      collections: ["collection/x"],
      created_at: "2020-01-01T00:00:00.000Z",
      toolkit_version: "2.8.2",
      template: { id: "template/empty", version: "1.1.0", builtin: true },
    });
  });

  it("refuses to clobber a corrupt manifest", () => {
    mkdirSync(join(dir, ".summer"));
    writeFileSync(projectManifestPath(dir), "{not json");
    expect(() => readProjectManifest(dir)).toThrow(/not valid JSON/);
    expect(() =>
      writeProjectManifest(dir, { template: { id: "template/empty", version: "1.1.0", builtin: true }, toolkit_version: "x" })
    ).toThrow(/not valid JSON/);
    expect(readFileSync(projectManifestPath(dir), "utf8")).toBe("{not json");
  });

  it("returns null when absent", () => {
    expect(readProjectManifest(dir)).toBeNull();
  });
});
