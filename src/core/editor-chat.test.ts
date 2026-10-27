import { describe, expect, it } from "vitest";
import { editorChatBlockedCall, editorChatInstructions, EDITOR_CHAT_JOB_SENTENCE, isEditorChat, isEditorChatBlockedOp } from "./editor-chat.js";

describe("editor chat gate", () => {
  it("is on only for SUMMER_EDITOR_CHAT=1", () => {
    expect(isEditorChat({ SUMMER_EDITOR_CHAT: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes"]) expect(isEditorChat({ SUMMER_EDITOR_CHAT: value })).toBe(false);
  });

  it("refuses waiting on and checking a job, and generation", () => {
    for (const op of ["jobs.wait", "jobs.get", "assets.generate_3d", "assets.generate_image", "assets.generate_audio", "assets.generate_sfx_choices", "assets.generate_video", "assets.generate_motion", "assets.generate_sprite_sheet", "assets.generate_new_kind", "assets.edit_image", "assets.rig", "assets.retexture", "assets.remove_background", "makers.bankai_motion"]) {
      expect(isEditorChatBlockedOp(op), op).toBe(true);
    }
    for (const op of ["jobs.list", "jobs.cancel", "assets.get", "assets.search", "assets.improve_prompt", "games.list", "store.go_live", "engine.add_node", "docs.search"]) {
      expect(isEditorChatBlockedOp(op), op).toBe(false);
    }
    expect(isEditorChatBlockedOp("makers.newer_than_the_catalog", "spend")).toBe(true);
    expect(isEditorChatBlockedOp("makers.newer_than_the_catalog", "read")).toBe(false);
  });

  it("finds the operation of a tool call by any of its names", () => {
    expect(editorChatBlockedCall("summer_jobs_wait", {})).toBe("jobs.wait");
    expect(editorChatBlockedCall("summer_check_job", {})).toBe("jobs.get");
    expect(editorChatBlockedCall("summer_assets_generate_3d", {})).toBe("assets.generate_3d");
    expect(editorChatBlockedCall("summer_generate_3d", {})).toBe("assets.generate_3d");
    expect(editorChatBlockedCall("summer_tool_bankai_motion", {})).toBe("makers.bankai_motion");
    expect(editorChatBlockedCall("summer_call", { op: "jobs.wait" })).toBe("jobs.wait");
    expect(editorChatBlockedCall("summer_call", { name: "summer_jobs_wait" })).toBe("jobs.wait");
    expect(editorChatBlockedCall("summer_call", { op: "summer_check_job" })).toBe("jobs.get");
    // The board's 3.x status tools were merged into jobs.get; they are not job waits.
    expect(editorChatBlockedCall("summer_board_build_status", {})).toBeNull();
    expect(editorChatBlockedCall("summer_call", { op: "summer_board_agent_task" })).toBeNull();
    for (const [tool, args] of [["summer_search", { query: "wait for a job" }], ["summer_call", {}], ["summer_call", { op: "games.list" }], ["summer_add_node", {}], ["summer_get_asset", {}]] as const) {
      expect(editorChatBlockedCall(tool, args)).toBeNull();
    }
  });

  it("adds the sentence to instructions with no job sentence", () => {
    expect(editorChatInstructions("Summer MCP.")).toBe(`Summer MCP. ${EDITOR_CHAT_JOB_SENTENCE}`);
  });
});
