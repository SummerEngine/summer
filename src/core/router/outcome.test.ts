import { describe, expect, it } from "vitest";
import { emit, failure, isAgentMode, success, type RouterIo } from "./outcome.js";

function io(isTTY: boolean, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: RouterIo = { out: (text) => out.push(text), err: (text) => err.push(text), isTTY, env };
  return { value, out, err };
}

describe("summer router agent mode", () => {
  it("is on for --json, a piped stdout, CI and agent environments; off for a person at a terminal", () => {
    expect(isAgentMode(true, true, {})).toBe(true);
    expect(isAgentMode(undefined, false, {})).toBe(true);
    expect(isAgentMode(undefined, true, { CI: "true" })).toBe(true);
    expect(isAgentMode(undefined, true, { CLAUDECODE: "1" })).toBe(true);
    expect(isAgentMode(undefined, true, { CODEX_SANDBOX: "seatbelt" })).toBe(true);
    expect(isAgentMode(undefined, true, {})).toBe(false);
  });

  it("puts only the JSON result on stdout and the message on stderr, with exit codes 0, 1 and 2", () => {
    const agent = io(false);
    expect(emit(agent.value, success({ pushed: [] }, ["done"]), undefined)).toBe(0);
    expect(JSON.parse(agent.out.join("\n"))).toEqual({ ok: true, pushed: [] });
    expect(agent.err).toEqual([]);

    const failed = io(false);
    expect(emit(failed.value, failure({ code: "tool_unhandled", message: "No handler.", fix: "Add one." }), undefined)).toBe(1);
    expect(JSON.parse(failed.out.join("\n"))).toEqual({ ok: false, error: { code: "tool_unhandled", message: "No handler.", fix: "Add one." } });
    expect(failed.err.join("\n")).toContain("Fix: Add one.");

    const usage = io(false);
    expect(emit(usage.value, failure({ code: "invalid_input", message: "Bad.", fix: "Fix." }, { exit: 2 }), undefined)).toBe(2);

    const person = io(true);
    emit(person.value, success({ pushed: [] }, ["  guard: created (version 1)"]), undefined);
    expect(person.out).toEqual(["  guard: created (version 1)"]);
  });
});
