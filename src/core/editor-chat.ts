import { errorAnswer, legacyNames, opForToolCall, resolveOpName, type Answer } from "./ops/contract.js";

/** The editor sets this for its own chat's MCP server and agent shell. */
export const EDITOR_CHAT_ENV = "SUMMER_EDITOR_CHAT";

export function isEditorChat(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EDITOR_CHAT_ENV] === "1";
}

export const EDITOR_CHAT_JOB_SENTENCE =
  "In the Summer editor chat, use summer_cloud for supported asset generation: native aj_ asset jobs deliver their results in this conversation, so never poll or wait for them. Other operations, including makers, builds and approvals, keep their normal job tracking.";

const JOB_SENTENCES = ["Long work answers with a job: jobs.wait.", "A job returns a jobId: summer_check_job."];

export function editorChatInstructions(text: string): string {
  const sentence = JOB_SENTENCES.find((candidate) => text.includes(candidate));
  return sentence ? text.split(sentence).join(EDITOR_CHAT_JOB_SENTENCE) : `${text} ${EDITOR_CHAT_JOB_SENTENCE}`;
}

export const EDITOR_CHAT_REFUSAL =
  "Use the Summer editor chat's summer_cloud tools for this asset operation. Native aj_ asset jobs deliver their results in this conversation; do not poll, wait or resubmit them. Other jobs keep their normal tracking.";

export function editorChatRefusal(op: string): Answer {
  return errorAnswer("unsupported", EDITOR_CHAT_REFUSAL, {
    next: { say: "Use the chat's summer_cloud tools; a native asset job's result arrives in this conversation." },
    details: { op, reason: "editor_chat" },
  });
}

/**
 * Explicit equivalents of the editor's generate3D / generate3DFromImage,
 * generateImage, generateAudio, generateAnimation / animateFromText,
 * editImage, rigModel, retexture3D and removeImageBackground tools.
 * Keep this list narrow: makers, videos, sprite sheets and future operations
 * have no guaranteed native equivalent. A paid operation is not enough to
 * establish that the editor can perform it or deliver its result.
 */
const NATIVE_ASSET_OPS: ReadonlySet<string> = new Set([
  "assets.generate_3d",
  "assets.generate_image",
  "assets.generate_audio",
  "assets.generate_motion",
  "assets.edit_image",
  "assets.rig",
  "assets.retexture",
  "assets.remove_background",
]);

/** Only these operations can be hidden without inspecting their input. */
export function isEditorChatBlockedOp(op: string): boolean {
  return NATIVE_ASSET_OPS.has(op);
}

/**
 * The editor's equinox_user_events.cpp accepts aj_ IDs for native asset jobs
 * (jobFamily: asset). The CLI can wrap a backend ID as gen:<id>. Do not infer
 * ownership from gen: alone or from an unprefixed legacy generation ID:
 * those may belong to makers or other CLI operations we still support.
 * cj_ native tasks and build:/upload:/apr:/op: jobs are not asset deliveries.
 */
export function isEditorNativeAssetJob(jobId: unknown): boolean {
  if (typeof jobId !== "string") return false;
  const id = jobId.trim().replace(/^gen:/, "");
  return id.length <= 256 && /^aj_[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id);
}

function blocked(op: string | null, args: unknown): string | null {
  if (!op) return null;
  if (isEditorChatBlockedOp(op)) return op;
  const input = args && typeof args === "object" ? args as { jobId?: unknown } : {};
  return (op === "jobs.get" || op === "jobs.wait") && isEditorNativeAssetJob(input.jobId) ? op : null;
}

/** Resolve generic, direct, v3 and v4 calls before any handler can run. */
export function editorChatBlockedCall(tool: string, args: unknown): string | null {
  if (tool === "summer_search") return null;
  if (tool === "summer_call") {
    const call = args && typeof args === "object" ? (args as { op?: unknown; name?: unknown; input?: unknown }) : {};
    const name = typeof call.op === "string" ? call.op.trim() : typeof call.name === "string" ? call.name.trim() : "";
    return name.includes(".") ? blocked(resolveOpName(name), call.input) : name ? editorChatBlockedCall(name, call.input) : null;
  }
  // The board's v3 status tools were merged into jobs.get; keep them intact.
  if (legacyNames()[tool]?.kind === "merge") return null;
  return blocked(opForToolCall(tool, args), args);
}
