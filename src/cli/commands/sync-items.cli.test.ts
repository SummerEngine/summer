import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchTool, ToolResultError } from "../../core/capabilities/tool-dispatch.js";
import { setSummerDirForTests } from "../../core/store.js";
import { runOpFromCli, type OpsCliDeps } from "./ops.js";

/**
 * The CLI faces of summer_sync_items (`summer economy sync-items`,
 * `summer tool sync-items`) report a bad summer.items.json the way the MCP
 * face does: every problem, by field, before anything reaches the store.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-sync-items-cli-"));
  setSummerDirForTests(join(root, ".summer"));
  await writeFile(join(root, "project.godot"), "[application]\n");
  await writeFile(
    join(root, "summer.items.json"),
    JSON.stringify({
      schema: "summer.items/v1",
      items: [
        { slug: "Emote Ponder", name: "Ponder", description: "Strike a thoughtful pose." },
        { slug: "emote_wave", name: "Wave", description: "Wave.", class: "COSMETIC" },
      ],
    })
  );
});

afterEach(async () => {
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

function deps(): OpsCliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const hosted = vi.fn(async () => {
    throw new Error("the hosted server must not be called");
  });
  return { hosted, dispatch: dispatchTool, print: (text) => out.push(text), printError: (text) => err.push(text), out, err };
}

describe("summer economy sync-items", () => {
  it("prints every manifest problem by field", async () => {
    const d = deps();
    expect(await runOpFromCli("economy.sync_items", ["--game-id", "game-1", "--project", root], d)).toBe(1);
    const printed = d.err.join("\n");
    expect(printed).toContain("items[0] (Emote Ponder): slug:");
    expect(printed).toContain("items[1] (emote_wave): cosmetic:");
  });

  it("carries the problem list in the --json answer", async () => {
    const d = deps();
    expect(await runOpFromCli("economy.sync_items", ["--game-id", "game-1", "--project", root, "--json"], d)).toBe(1);
    const answer = JSON.parse(d.err[0]);
    expect(answer).toMatchObject({ ok: false, error: { details: { tool: { code: "items_manifest_invalid" } } } });
    expect(answer.error.details.tool.problems).toHaveLength(2);
  });
});

describe("summer tool sync-items", () => {
  it("fails with the same structured failure the MCP face gives", async () => {
    const failure = await dispatchTool("sync-items", { gameId: "game-1", project: root }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolResultError);
    expect((failure as ToolResultError).result).toMatchObject({ ok: false, code: "items_manifest_invalid", recovery: expect.stringContaining("Recovery") });
    expect((failure as ToolResultError).result.problems).toHaveLength(2);
  });
});
