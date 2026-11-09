import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../../../scripts/validate-library/json-schema.ts";
import { PACKAGE_ROOT } from "../package-root.js";
import { localEntries, localInputSchema, localWireForm } from "./catalog.js";
import { isLocalOp, legacyNames, MIN_APPROVAL, opForToolCall, resolveOpName } from "./contract.js";
import { ENGINE_OPS, ENGINE_SPLIT_OPS, engineOpDef, opsNamedIn, renderOpRefs, splitToolArgs } from "./engine.js";

const schema = JSON.parse(readFileSync(join(PACKAGE_ROOT, "registry", "schemas", "operation.schema.json"), "utf8")) as Record<string, unknown>;
const engineOps = [...new Set(Object.values(legacyNames()).map((row) => row.op).filter((op) => op.startsWith("engine.")))].sort();
/** SPEC §6.5: no price text in a summary. */
const PRICE_TEXT = /\$|\bper\b|markup|cost of/i;

describe("the engine area", () => {
  it("defines every engine operation of legacy-names.json, and nothing else", () => {
    expect(engineOps.length).toBeGreaterThanOrEqual(85);
    expect(engineOps.filter((op) => !engineOpDef(op))).toEqual([]);
    const defined = [...Object.keys(ENGINE_OPS), ...Object.keys(ENGINE_SPLIT_OPS)].sort();
    expect(defined).toEqual(engineOps);
  });

  it.each(engineOps)("%s: its wire form passes the contract, with a short summary and no price text", (op) => {
    const wire = localWireForm(op);
    expect(wire, `${op} is in the local catalog`).not.toBeNull();
    expect(validateAgainstSchema(wire, schema, new Map())).toEqual([]);
    const def = engineOpDef(op)!;
    expect(def.summary.length).toBeLessThanOrEqual(300);
    expect(def.summary).not.toMatch(PRICE_TEXT);
    expect(wire).toMatchObject({ provider: "engine", effect: def.effect, approval: MIN_APPROVAL[def.effect], since: "4.0" });
  });

  it.each(engineOps)("%s: its example is a valid input", (op) => {
    const input = localInputSchema(op);
    expect(input, `${op} has an input schema`).not.toBeNull();
    expect(validateAgainstSchema(engineOpDef(op)!.example.input, input, new Map())).toEqual([]);
  });

  it("names only operations that run in this package", () => {
    const local = new Set(localEntries().map((entry) => entry.name));
    const unknown = engineOps.flatMap((op) => opsNamedIn(engineOpDef(op)!.summary).filter((named) => !local.has(named)).map((named) => `${op} -> ${named}`));
    expect(unknown).toEqual([]);
  });

  it("keeps the 3.x MCP name of every engine tool", () => {
    expect(localWireForm("engine.set_prop")).toMatchObject({ mcpName: "summer_set_prop", legacy: ["summer_set_prop"] });
    expect(localEntries().find((entry) => entry.name === "engine.run_script")).toMatchObject({ mcpTool: "summer_run_script", status: "stable" });
  });
});

describe("operations split out of mixed 3.x tools", () => {
  it("separate the read from the change", () => {
    expect(ENGINE_SPLIT_OPS["engine.list_camera_bookmarks"].effect).toBe("read");
    expect(ENGINE_SPLIT_OPS["engine.save_camera_bookmark"].effect).toBe("write");
    expect(ENGINE_SPLIT_OPS["engine.list_ui_actions"].effect).toBe("read");
    expect(ENGINE_SPLIT_OPS["engine.invoke_ui_action"].effect).toBe("write");
  });

  it("take only their own fields and run their tool with the action fixed", () => {
    expect(localInputSchema("engine.save_camera_bookmark")).toEqual({
      type: "object",
      properties: expect.objectContaining({ name: expect.any(Object), position: expect.any(Object) }),
      required: ["name"],
      additionalProperties: false,
    });
    expect(Object.keys((localInputSchema("engine.list_camera_bookmarks") as { properties: object }).properties)).toEqual([]);
    expect(splitToolArgs(ENGINE_SPLIT_OPS["engine.save_camera_bookmark"], { name: "hero", action: "delete", mode: "x" })).toEqual({ name: "hero", action: "save" });
    expect(splitToolArgs(ENGINE_SPLIT_OPS["engine.invoke_ui_action"], { action_name: "editor/save_scene" })).toEqual({ action_name: "editor/save_scene", mode: "invoke" });
  });

  it("are their own tools, reached from the 3.x name by its action", () => {
    expect(localEntries().find((entry) => entry.name === "engine.save_camera_bookmark")).toMatchObject({ mcpTool: "summer_engine_save_camera_bookmark", legacy: ["summer_camera_bookmark#save"] });
    expect(resolveOpName("summer_camera_bookmark#delete")).toBe("engine.delete_camera_bookmark");
    expect(opForToolCall("summer_camera_bookmark", { action: "save", name: "a" })).toBe("engine.save_camera_bookmark");
    expect(opForToolCall("summer_ui_actions", { mode: "invoke" })).toBe("engine.invoke_ui_action");
    expect(opForToolCall("summer_ui_actions", { mode: "list" })).toBe("engine.list_ui_actions");
    expect(opForToolCall("summer_engine_save_camera_bookmark", {})).toBe("engine.save_camera_bookmark");
    expect(opForToolCall("summer_call", { op: "summer_camera_bookmark", input: { action: "delete" } })).toBe("engine.delete_camera_bookmark");
    expect(opForToolCall("summer_call", { op: "summer_engine_invoke_ui_action" })).toBe("engine.invoke_ui_action");
    expect(opForToolCall("summer_call", { op: "summer_not_a_tool" })).toBeNull();
    expect(isLocalOp("engine.invoke_ui_action")).toBe(true);
  });
});

describe("summaries in a view", () => {
  it("name each operation as the tool that runs it there", () => {
    const tools: Record<string, string> = { "engine.snapshot_diff": "summer_snapshot_diff", "docs.read": "summer_docs_read" };
    expect(renderOpRefs("Next: engine.snapshot_diff, then docs.read; engine.ui_tree stays.", (op) => tools[op])).toBe(
      "Next: summer_snapshot_diff, then summer_docs_read; engine.ui_tree stays."
    );
  });
});
