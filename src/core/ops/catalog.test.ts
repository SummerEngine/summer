import { describe, expect, it } from "vitest";
import { knownOp, localEntries, localInputSchema, resolveCliOp, unknownInputField } from "./catalog.js";

describe("knownOp", () => {
  it("keeps a real operation, local or cloud, and drops any other word", () => {
    expect(knownOp("engine.set_prop")).toBe("engine.set_prop");
    expect(knownOp("games.list")).toBe("games.list");
    expect(knownOp("engine.my_secret_game_jane_doe")).toBeNull();
    expect(knownOp(null)).toBeNull();
  });
});

describe("Remix command discovery", () => {
  it("exposes the same explicit per-game write to CLI and MCP", () => {
    expect(resolveCliOp("games", "set-remix")).toBe("games.set_remix");
    expect(localEntries().find((entry) => entry.name === "games.set_remix")).toMatchObject({
      provider: "local", effect: "write", mcpTool: "summer_games_set_remix",
    });
    expect(localInputSchema("games.set_remix")).toMatchObject({
      required: ["gameId", "spinnable"], properties: { spinnable: { type: "boolean" } },
    });
  });
});

it("exposes the verified Remix download as a local write without account sign-in", () => {
  expect(resolveCliOp("games", "download-remix")).toBe("games.download_remix");
  const entry = localEntries().find(entry => entry.name === "games.download_remix");
  expect(entry).toMatchObject({ provider: "local", effect: "write", mcpTool: "summer_games_download_remix" });
  expect(entry?.needsSignIn).toBeUndefined();
});

it("checks only undeclared top-level fields in a closed schema", () => {
  const closed = { additionalProperties: false, required: ["name"], properties: { name: {}, props: { type: "object" } } };
  expect(unknownInputField(closed, {})).toBeNull();
  expect(unknownInputField(closed, { props: { material_override: "res://custom.tres" } })).toBeNull();
  expect(unknownInputField(closed, { toString: "unexpected" })).toContain("toString");
  expect(unknownInputField({ ...closed, additionalProperties: true }, { custom: 1 })).toBeNull();
  expect(unknownInputField(null, { custom: 1 })).toBeNull();
});
