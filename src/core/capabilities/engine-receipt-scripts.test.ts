import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractOpError } from "./engine-receipt.js";

// Captured native RunEditorScript failure from the owned headless V4 audit.
const editorScriptFailure = JSON.parse(readFileSync(new URL("../../../tests/fixtures/script-failure.json", import.meta.url), "utf8"));

function failure(row: Record<string, unknown>) {
  return JSON.parse(extractOpError({ status: "error", results: [{ ok: false, ...row }] })!);
}

describe("script failure diagnostics", () => {
  it("retains the actual cold editor diagnostic without exposing the raw child result", () => {
    const result = JSON.parse(extractOpError(editorScriptFailure)!);
    expect(result.errors).toEqual(["ERROR|core/variant/variant_utility.cpp:1023|push_error|AUDIT_EXPECTED_DIAGNOSTIC|"]);
    expect(result).toMatchObject({ op: "RunEditorScript", failure_reason: "engine_error", ran: true, exit_code: 1, line_offset: 2, errors_truncated: 0 });
    expect(result.boot_errors).toEqual([]);
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("out_dir");
    expect(result).not.toHaveProperty("checkpoint");
  });

  it("keeps boot and stderr diagnostics when a cold script never ran", () => {
    expect(failure({ op: "RunEditorScript", failure_reason: "script_parse_failed", error: "Could not load the script.", ran: false, exit_code: 1, boot_errors: ["Parse Error: missing ':' at line 3"], stderr: ["Failed to load script"], normalizations: ["prepended extends EditorScript"], line_offset: 2 })).toMatchObject({
      boot_errors: ["Parse Error: missing ':' at line 3"], stderr: ["Failed to load script"], ran: false, exit_code: 1, line_offset: 2,
    });
  });

  it("keeps structured scene parse locations, with only diagnostic fields", () => {
    const result = failure({ op: "RunSceneScript", failure_reason: "parse_error", error: "The script does not compile.", parse_errors: [{ line: 4, column: 9, message: "Expected expression.", unrelated: "omit" }], line_offset: 2 });
    expect(result.parse_errors).toEqual([{ line: 4, column: 9, message: "Expected expression." }]);
    expect(result.line_offset).toBe(2);
  });

  it("retains runtime errors and native rollback/budget state", () => {
    expect(failure({ op: "RunSceneScript", failure_reason: "runtime_error", error: "The script raised errors.", errors: ["SCRIPT ERROR|bad call"], rolled_back: true, budget_enforced: true, budget_exceeded: false, lines_truncated: 3 })).toMatchObject({
      errors: ["SCRIPT ERROR|bad call"], rolled_back: true, budget_enforced: true, budget_exceeded: false, lines_truncated: 3,
    });
  });

  it("supports a flat script failure without inventing a classifier", () => {
    const result = JSON.parse(extractOpError({ ok: false, op: "RunEditorScript", error: "See errors.", errors: ["actionable"], line_offset: 0 })!);
    expect(result).toMatchObject({ error: "See errors.", op: "RunEditorScript", errors: ["actionable"] });
    expect(result).not.toHaveProperty("failure_reason");
  });

  it("uses only the failing operation, not a successful sibling or envelope diagnostics", () => {
    const result = JSON.parse(extractOpError({ errors: ["unrelated envelope"], results: [
      { ok: true, op: "RunEditorScript", errors: ["successful sibling"] },
      { ok: false, op: "RunEditorScript", failure_reason: "engine_error", error: "Failed.", errors: ["failed script"] },
    ] })!);
    expect(result.errors).toEqual(["failed script"]);
  });

  it("never interprets a scene script's user return value as diagnostics", () => {
    const result = failure({ op: "RunSceneScript", failure_reason: "runtime_error", error: "Failed.", result: { errors: ["user data"], stderr: ["user data"], rolled_back: true } });
    expect(result).not.toHaveProperty("errors");
    expect(result).not.toHaveProperty("stderr");
    expect(result).not.toHaveProperty("rolled_back");
  });

  it("does not expose arbitrary fields or project script diagnostics onto other operations", () => {
    const result = failure({ op: "SetProp", failure_reason: "invalid_input", error: "Bad value.", errors: ["not a script"], secret: "omit" });
    expect(result).not.toHaveProperty("errors");
    expect(result).not.toHaveProperty("secret");
    const script = failure({ op: "RunEditorScript", failure_reason: "engine_error", error: "Failed.", errors: { raw: "omit" }, boot_errors: [42, { arbitrary: "omit" }], parse_errors: [{ arbitrary: "omit" }], line_offset: "bad", secret: "omit" });
    expect(script).not.toHaveProperty("errors");
    expect(script.boot_errors).toEqual([]);
    expect(script.parse_errors).toEqual([]);
    expect(script).not.toHaveProperty("line_offset");
    expect(script).not.toHaveProperty("secret");
  });

  it("leaves successful script receipts on the existing success path", () => {
    expect(extractOpError({ ok: true, results: [{ ok: true, op: "RunSceneScript", errors: ["reported warning"] }] })).toBeNull();
  });
});
