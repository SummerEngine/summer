import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithToolContext } from "./agent-host.js";
import { setSummerDirForTests } from "./store.js";
import {
  _resetUsageFieldsForTests,
  cleanUsageFields,
  noteBoundProject,
  noteToolUsage,
  processUsageFields,
  templateForProject,
  templateTags,
  usageLineFields,
} from "./usage-fields.js";

let root = "";
const hash = "b".repeat(64);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "summer-usage-fields-"));
  setSummerDirForTests(join(root, ".summer"));
  _resetUsageFieldsForTests();
});

afterEach(() => {
  setSummerDirForTests(null);
  rmSync(root, { recursive: true, force: true });
});

describe("cleanUsageFields", () => {
  it("keeps only hashes, catalog-shaped slugs and small counts", () => {
    expect(
      cleanUsageFields({
        projectIdHash: "/Users/jane/My Game",
        templateId: "Jane's game",
        templateTags: ["2d", "prompt: make me a game", 7],
        instanceCount: 1000,
        prompt: "never",
      })
    ).toEqual({ templateTags: ["2d"] });
    expect(cleanUsageFields({ projectIdHash: hash, templateId: "3d-basic", instanceCount: 2 })).toEqual({ projectIdHash: hash, templateId: "3d-basic", instanceCount: 2 });
  });
});

describe("noteToolUsage", () => {
  it("lands on the outer call's line when a tool runs another tool, and on the process line", async () => {
    let outer: Record<string, unknown> = {};
    await runWithToolContext("summer_call", "mcp", async () => {
      outer = (await import("./agent-host.js")).currentToolContext()!.usage;
      await runWithToolContext("summer_play", "mcp", async () => noteToolUsage({ instanceCount: 2 }));
    });
    expect(outer).toEqual({ instanceCount: 2 });
    noteBoundProject(hash);
    expect(processUsageFields()).toEqual({ projectIdHash: hash, instanceCount: 2 });
  });
});

describe("templates", () => {
  it("reads a catalog template's library domains", () => {
    expect(templateTags("2d-platformer")).toContain("platformer");
    expect(templateTags("not-a-template")).toEqual([]);
  });

  it("finds the template of the project a running editor has open, and only catalog ones", async () => {
    const project = join(root, "game");
    mkdirSync(join(project, ".summer"), { recursive: true });
    writeFileSync(join(project, ".summer", "project.json"), JSON.stringify({ template: { id: "template/3d-racing-game", version: "1" } }));
    const instances = join(root, ".summer", "instances");
    mkdirSync(instances, { recursive: true });
    const instance = { schemaVersion: 1, instanceId: "i1", pid: process.pid, port: 4001, token: "t", projectIdHash: hash, resourceRoot: project, heartbeatAt: Math.floor(Date.now() / 1000) };
    writeFileSync(join(instances, "i1.json"), JSON.stringify(instance));
    expect(await templateForProject(hash)).toBe("3d-racing-game");
    expect(await usageLineFields({ projectIdHash: hash })).toEqual({ projectIdHash: hash, templateId: "3d-racing-game" });

    _resetUsageFieldsForTests();
    writeFileSync(join(project, ".summer", "project.json"), JSON.stringify({ template: { id: "my private thing", version: "1" } }));
    expect(await templateForProject(hash)).toBeNull();
  });
});
