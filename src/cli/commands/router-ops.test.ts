import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchTool } from "../../core/capabilities/tool-dispatch.js";
import { isLocalOp } from "../../core/ops/contract.js";
import { localEntries } from "../../core/ops/catalog.js";
import { CLI_AREAS, runOpFromCli, type OpsCliDeps } from "./ops.js";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "summer-router-ops-"));
  writeFileSync(join(root, "project.godot"), "[application]\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deps(): OpsCliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { hosted: vi.fn(), dispatch: dispatchTool, print: (text) => out.push(text), printError: (text) => err.push(text), out, err };
}

describe("summer router <action>: the Summer Router local operations", () => {
  it("are local operations in the catalog, under the router CLI area", () => {
    expect(CLI_AREAS).toContain("router");
    for (const op of ["router.setup", "router.add_character", "router.check", "router.push", "router.pull", "router.doctor"]) {
      expect(isLocalOp(op)).toBe(true);
      expect(localEntries().find((entry) => entry.name === op)).toMatchObject({ provider: "local", mcpTool: `summer_${op.replace(".", "_")}` });
    }
    expect(isLocalOp("router.test")).toBe(false);
  });

  it("add-character, then check: tool_unhandled with the contract code, then a pass once GDScript registers the tool", async () => {
    const run = deps();
    expect(await runOpFromCli("router.add_character", ["--id", "guard", "--tools", "open_gate,give_key", "--project", root, "--json"], run)).toBe(0);
    expect(JSON.parse(run.out[0])).toMatchObject({ ok: true, status: "done", result: { character: "guard", unhandled_tools: ["open_gate", "give_key"] } });

    const refused = deps();
    expect(await runOpFromCli("router.check", ["--project", root, "--json"], refused)).toBe(1);
    expect(JSON.parse(refused.err[0])).toMatchObject({ ok: false, error: { code: "invalid_input", details: { tool: { reason: "tool_unhandled" } } } });

    writeFileSync(join(root, "gate.gd"), `func _ready():\n\t$Guard.tool("open_gate", _o)\n\tSummer.client.router.talk("guard", {"tools": {"give_key": _g}})\n`);
    const passed = deps();
    expect(await runOpFromCli("router.check", ["--project", root, "--json"], passed)).toBe(0);
    expect(JSON.parse(passed.out[0])).toMatchObject({ ok: true, result: { valid: true } });
  });

  it("asks for the required id before running", async () => {
    const run = deps();
    expect(await runOpFromCli("router.add_character", ["--project", root, "--json"], run)).toBe(1);
    expect(JSON.parse(run.err[0])).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
