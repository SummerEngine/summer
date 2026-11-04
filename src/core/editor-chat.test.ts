import { describe, expect, it } from "vitest";
import { editorChatBlockedCall, editorChatInstructions, EDITOR_CHAT_JOB_SENTENCE, isEditorChat, isEditorChatBlockedOp } from "./editor-chat.js";

describe("editor chat gate", () => {
  it("is on only for SUMMER_EDITOR_CHAT=1", () => {
    expect(isEditorChat({ SUMMER_EDITOR_CHAT: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes"]) expect(isEditorChat({ SUMMER_EDITOR_CHAT: value })).toBe(false);
  });

  it("redirects only operations with a native summer_cloud equivalent", () => {
    for (const op of ["assets.generate_3d", "assets.generate_image", "assets.generate_audio", "assets.generate_motion", "assets.edit_image", "assets.rig", "assets.retexture", "assets.remove_background"]) {
      expect(isEditorChatBlockedOp(op), op).toBe(true);
    }
    for (const op of ["jobs.wait", "jobs.get", "jobs.list", "jobs.cancel", "assets.get", "assets.search", "assets.improve_prompt", "assets.generate_video", "assets.generate_sprite_sheet", "assets.generate_sfx_choices", "assets.generate_new_kind", "makers.bankai_motion", "makers.newer_than_the_catalog", "projects.build", "store.publish", "engine.add_node", "docs.search"]) {
      expect(isEditorChatBlockedOp(op), op).toBe(false);
    }
  });

  it.each(["aj_call-status", "gen:aj_call-status"])("refuses native asset job %s through every call shape", (jobId) => {
    expect(editorChatBlockedCall("summer_jobs_wait", { jobId })).toBe("jobs.wait");
    expect(editorChatBlockedCall("summer_check_job", { jobId })).toBe("jobs.get");
    for (const key of ["op", "name"]) {
      for (const name of ["jobs.wait", "summer_jobs_wait"]) {
        expect(editorChatBlockedCall("summer_call", { [key]: name, input: { jobId } })).toBe("jobs.wait");
      }
      expect(editorChatBlockedCall("summer_call", { [key]: "summer_check_job", input: { jobId } })).toBe("jobs.get");
    }
  });

  it.each(["build:1", "upload:1", "apr:1", "op:1", "plan:1", "engine:1", "gen:existing-cli-job", "legacy-generation-id", "cj_00000000-0000-4000-8000-000000000001"])("preserves tracking for %s", (jobId) => {
    expect(editorChatBlockedCall("summer_jobs_wait", { jobId })).toBeNull();
    expect(editorChatBlockedCall("summer_check_job", { jobId })).toBeNull();
    expect(editorChatBlockedCall("summer_call", { op: "jobs.get", input: { jobId } })).toBeNull();
    expect(editorChatBlockedCall("summer_call", { name: "summer_jobs_wait", input: { jobId } })).toBeNull();
  });

  it("keeps job tools discoverable and leaves missing/invalid IDs to validation", () => {
    for (const jobId of [undefined, null, 1, "", "aj_", "aj_ bad"]) {
      expect(editorChatBlockedCall("summer_jobs_wait", { jobId })).toBeNull();
    }
    expect(editorChatBlockedCall("summer_jobs_wait", {})).toBeNull();
    expect(editorChatBlockedCall("summer_check_job", {})).toBeNull();
    expect(editorChatBlockedCall("summer_board_build_status", {})).toBeNull();
    expect(editorChatBlockedCall("summer_call", { op: "summer_board_agent_task" })).toBeNull();
  });

  it("finds native generation aliases without blocking makers", () => {
    for (const name of ["assets.generate_3d", "summer_assets_generate_3d", "summer_generate_3d"]) {
      expect(editorChatBlockedCall("summer_call", { op: name })).toBe("assets.generate_3d");
    }
    expect(editorChatBlockedCall("summer_assets_generate_3d", {})).toBe("assets.generate_3d");
    expect(editorChatBlockedCall("summer_tool_bankai_motion", {})).toBeNull();
    expect(editorChatBlockedCall("summer_call", { op: "makers.bankai_motion" })).toBeNull();
  });

  it("adds the sentence to instructions with no job sentence", () => {
    expect(editorChatInstructions("Summer MCP.")).toBe(`Summer MCP. ${EDITOR_CHAT_JOB_SENTENCE}`);
  });
});
