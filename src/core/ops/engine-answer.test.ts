import { describe, expect, it } from "vitest";
import { answerOfEngineResult, engineFailure } from "./engine-answer.js";

const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });
const write = { effect: "write" as const, guide: "tool/set-prop" };
const read = { effect: "read" as const, guide: "tool/get-scene-tree" };

describe("an engine tool's result as the one answer shape", () => {
  it("carries the tool's payload as the result, and a tip as a warning", () => {
    const raw = { content: [{ type: "text", text: '{"ok":true,"saved":true}' }, { type: "text", text: "Tip: 4 single scene edits in a row." }] };
    expect(answerOfEngineResult(raw, "engine.set_prop", write)).toEqual({ ok: true, status: "done", result: { ok: true, saved: true }, warnings: ["Tip: 4 single scene edits in a row."] });
    expect(answerOfEngineResult(text("Editor viewport, 1280x720"), "engine.screenshot", read)).toEqual({ ok: true, status: "done", result: { text: "Editor viewport, 1280x720" } });
  });

  it("says engine_not_running with one next step, from the 3.x plain text", () => {
    const raw = text(
      "Summer Engine is not running (no api-token found). Open Summer Engine first.\nOpen the intended project in Summer Engine, or run: npx -y summer-engine@latest run\nNote: only tools that touch the local project need the engine.",
      true
    );
    const answer = answerOfEngineResult(raw, "engine.get_scene_tree", read);
    expect(answer).toEqual({
      ok: false,
      error: { code: "engine_not_running", message: "Summer Engine is not running, or no project is open.", next: { say: expect.stringContaining("Open the project in Summer Engine") }, retry: "safe" },
    });
    expect(JSON.stringify(answer)).not.toContain("api-token");
  });

  it("reads the coded 3.x shape too, keeping its own next step", () => {
    const raw = text(JSON.stringify({ ok: false, code: "engine_not_running", error: "Summer Engine is not running.", recovery: "Open the project" }), true);
    expect(answerOfEngineResult(raw, "engine.play", write)).toMatchObject({ ok: false, error: { code: "engine_not_running", retry: "safe", next: { say: "Open the project" } } });
  });

  it("finds engine_not_running inside a coded failure, and names the sentence over the code", () => {
    const importDown = JSON.stringify({ error: "import_failed", message: "Summer Engine is not running (no api-token found). Open Summer Engine first." });
    expect(engineFailure(importDown, "engine.import_asset_by_id", write)).toMatchObject({ ok: false, error: { code: "engine_not_running" } });
    expect(engineFailure(JSON.stringify({ error: "asset_not_found", message: "No asset a_1." }), "engine.import_asset_by_id", write)).toMatchObject({
      ok: false,
      error: { code: "not_found", message: "No asset a_1." },
    });
    const several = "Multiple Summer editors are running and this agent is not inside a Summer project. Start the agent from the project directory, or pass `summer mcp --project <path>`.";
    expect(engineFailure(several, "engine.play", write)).toMatchObject({ ok: false, error: { code: "conflict", next: { say: expect.stringContaining("--project") } } });
  });

  it("separates a read that can be retried from a change that may have partly applied", () => {
    const transport = "fetch failed\n\nRecovery: (1) check the engine is running and responsive — summer_get_project_context here";
    expect(engineFailure(transport, "engine.get_scene_tree", read)).toMatchObject({ ok: false, error: { code: "unavailable", retry: "safe" } });
    expect(engineFailure(transport, "engine.set_prop", write)).toMatchObject({ ok: false, error: { code: "outcome_unknown", retry: "no", next: { op: "engine.get_scene_tree" } } });
    expect(engineFailure(transport, "engine.write_file", write)).toMatchObject({ error: { next: { op: "engine.read_file" } } });
  });

  it("points a bad input at the tool's guide and keeps the engine's own failure whole", () => {
    const failure = { error: "name must be 1-64 characters", failure_reason: "bad_args", op: "SaveCameraBookmark" };
    expect(engineFailure(`${JSON.stringify(failure)}\n\nHint: check the name`, "engine.save_camera_bookmark", write)).toEqual({
      ok: false,
      error: { code: "invalid_input", message: "name must be 1-64 characters", next: { op: "docs.read", input: { id: "tool/set-prop" } }, retry: "no", details: { tool: failure } },
    });
  });

  it("maps the engine's failure reasons to their codes", () => {
    const cases: Array<[Record<string, unknown>, string, unknown]> = [
      [{ error: "This engine build lacks RunSceneScript", failure_reason: "engine_lacks_op" }, "engine_lacks_op", { say: "Update Summer Engine." }],
      [{ error: "No game is running", failure_reason: "game_not_running" }, "not_found", { op: "engine.play" }],
      [{ error: "Wrong project", failure_reason: "identity_mismatch" }, "conflict", { op: "engine.get_project_context" }],
      [{ error: "Snapshot expired", failure_reason: "unknown_snapshot" }, "not_found", { op: "engine.world_snapshot" }],
      [{ error: "Another script runs", failure_reason: "busy" }, "in_progress", undefined],
    ];
    for (const [body, code, next] of cases) {
      const answer = engineFailure(JSON.stringify(body), "engine.run_script", write);
      expect(answer).toMatchObject({ ok: false, error: { code } });
      if (!answer.ok) expect(answer.error.next).toEqual(next);
    }
  });
});

describe("a signed-out tool's sign-in link", () => {
  it("keeps not_signed_in and makes the link the next step", () => {
    const text = JSON.stringify({
      ok: false,
      code: "not_signed_in",
      error: "Not signed in to Summer.",
      signInUrl: "https://www.summerengine.com/login?cli_session=abc",
      recovery: "Sign-in link for the person: https://www.summerengine.com/login?cli_session=abc",
    });
    const answer = engineFailure(text, "assets.search", { effect: "read" }) as { ok: false; error: { code: string; next?: { say?: string } } };
    expect(answer.error.code).toBe("not_signed_in");
    expect(answer.error.next?.say).toContain("https://www.summerengine.com/login?cli_session=abc");
  });
});
