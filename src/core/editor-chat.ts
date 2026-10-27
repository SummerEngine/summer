import { errorAnswer, legacyNames, opForToolCall, resolveOpName, type Answer, type Effect } from "./ops/contract.js";
import { publicCatalog } from "./ops/public-catalog.js";

/**
 * The Summer editor's own chat (SUMMER_EDITOR_CHAT=1, set by the editor in
 * this MCP server's environment and in its agent's shell). There, assets are
 * generated only with the chat's summer_cloud tools: they return at once and
 * the finished job arrives as a message in the conversation. So in that chat
 * this package never waits on, polls or checks a job, and never starts a
 * generation itself: the MCP instructions say so, and summer_call, the
 * direct tools, summer_search and the CLI refuse or hide those operations.
 * Without the variable nothing changes.
 */

export const EDITOR_CHAT_ENV = "SUMMER_EDITOR_CHAT";

export function isEditorChat(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EDITOR_CHAT_ENV] === "1";
}

/** The sentence the editor chat's MCP instructions carry in place of the job sentence. */
export const EDITOR_CHAT_JOB_SENTENCE =
  "In the Summer editor chat, generate assets only with the chat's summer_cloud tools: they return at once, and a message in this conversation tells you when each job finishes. Never wait for, poll or check on a job.";

/** The job sentences of the instruction strings outside the editor chat (server.ts, ops-surface.ts). */
const JOB_SENTENCES = ["Long work answers with a job: jobs.wait.", "A job returns a jobId: summer_check_job."];

/** Instructions for the editor chat: the job sentence replaced, or the editor sentence added when there is none. */
export function editorChatInstructions(text: string): string {
  const sentence = JOB_SENTENCES.find((candidate) => text.includes(candidate));
  return sentence ? text.split(sentence).join(EDITOR_CHAT_JOB_SENTENCE) : `${text} ${EDITOR_CHAT_JOB_SENTENCE}`;
}

export const EDITOR_CHAT_REFUSAL =
  "This does not run in the Summer editor chat: generate assets only with the chat's summer_cloud tools. The finished job arrives as a message in this conversation; never wait for, poll or check on a job.";

/** The answer a refused operation gets, at once and with no call to Summer's server. */
export function editorChatRefusal(op: string): Answer {
  return errorAnswer("unsupported", EDITOR_CHAT_REFUSAL, {
    next: { say: "Use the chat's summer_cloud tools; the result arrives as a message in this conversation." },
    details: { op, reason: "editor_chat" },
  });
}

const JOB_OPS: ReadonlySet<string> = new Set(["jobs.wait", "jobs.get"]);
/** Paid, but makes no asset and answers at once (a better prompt). */
const NOT_GENERATION: ReadonlySet<string> = new Set(["assets.improve_prompt"]);

let effects: Map<string, Effect> | null = null;
const effectOf = (op: string): Effect | undefined => {
  effects ??= new Map(publicCatalog().operations.map((row) => [row.name, row.effect]));
  return effects.get(op);
};

/**
 * True for the operations the editor chat refuses: waiting on or checking a
 * job (jobs.wait, jobs.get) and generation: every assets.generate_*, and the
 * other paid assets and makers operations (edit, rig, retexture, remove a
 * background, the makers' jobs). `effect` is the live catalog row's, for an
 * operation newer than the shipped catalog.
 */
export function isEditorChatBlockedOp(op: string, effect?: Effect): boolean {
  if (JOB_OPS.has(op) || op.startsWith("assets.generate_")) return true;
  if (NOT_GENERATION.has(op) || !/^(assets|makers)\./.test(op)) return false;
  return (effect ?? effectOf(op)) === "spend";
}

/**
 * The refused operation a tool call would run, or null: summer_call's op (or
 * its `name`), or a direct tool's (summer_jobs_wait, summer_check_job,
 * summer_assets_generate_3d, summer_generate_image, summer_tool_*). A 3.x
 * tool merged into jobs.get (the board's task and build status) is not a job
 * wait and stays.
 */
export function editorChatBlockedCall(tool: string, args: unknown): string | null {
  if (tool === "summer_search") return null;
  if (tool === "summer_call") {
    const call = args && typeof args === "object" ? (args as { op?: unknown; name?: unknown; input?: unknown }) : {};
    const name = typeof call.op === "string" ? call.op.trim() : typeof call.name === "string" ? call.name.trim() : "";
    // An operation name, or a tool name (3.x or v4) passed as the op.
    return name.includes(".") ? blocked(resolveOpName(name)) : name ? editorChatBlockedCall(name, call.input) : null;
  }
  if (legacyNames()[tool]?.kind === "merge") return null;
  return blocked(opForToolCall(tool, args));
}

const blocked = (op: string | null): string | null => (op && isEditorChatBlockedOp(op) ? op : null);
