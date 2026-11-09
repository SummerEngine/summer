import { errorAnswer, type Answer, type ErrorCode, type NextStep } from "./contract.js";

/**
 * A 3.x engine tool's result as the one answer shape (SPEC §5.2, §5.5).
 * Success: `{ok, status: "done", result}` with the tool's own payload as
 * the result. Failure: one stable code with one next step; the engine's
 * structured failure (failure_reason, receipts) travels whole in
 * `details.tool`, so nothing the 3.x result said is lost.
 */

export const ENGINE_NOT_RUNNING_STEP: NextStep = {
  say: "Open the project in Summer Engine, or run: npx -y summer-engine@latest run <project-path>",
};

/** `recovery`: the 3.x result's own next step (not installed, no project, still starting, ...). */
export function engineNotRunning(recovery?: string): Answer {
  return errorAnswer("engine_not_running", "Summer Engine is not running, or no project is open.", { next: recovery ? { say: recovery } : ENGINE_NOT_RUNNING_STEP });
}

type Content = { type?: string; text?: unknown };

/** The text blocks of a tool result: the first is its payload, the rest are notes (a tip, a caption). */
export function textsOf(result: unknown): string[] {
  const content = result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  return Array.isArray(content)
    ? (content as Content[]).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text as string)
    : [];
}

function parsePayload(text: string): unknown {
  // A classified engine failure is JSON, sometimes followed by a plain "Hint:" paragraph.
  const json = text.split(/\n\nHint: /)[0];
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** The 4.0 codes a 3.x result may already carry (`{ok:false, code}`, summer PR #139). */
const PASSED_CODES = new Set<ErrorCode>(["engine_not_running", "engine_lacks_op", "not_signed_in", "no_credits", "unavailable", "invalid_input", "not_found"]);

const NOT_RUNNING = /Summer Engine is not running|Summer Engine( instance \S+)? is not responding on port|No running Summer editor matches/;
/** Several editors run and none was picked for this session. */
const SEVERAL_EDITORS = /Multiple Summer editors are running/;
const SEVERAL_EDITORS_STEP: NextStep = { say: "Several Summer editors are open: start the agent in the project folder, or run the MCP with --project <path>." };
const NO_PROJECT = /No project\.godot found/;
/** withEngine's transport recipe: the call failed between this package and the engine, mid-request. */
const TRANSPORT = /Recovery: \(1\) check the engine is running/;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Where to read after a failure that may have changed something. */
function readAfter(op: string): NextStep {
  if (op === "engine.write_file" || op === "engine.replace_text") return { op: "engine.read_file" };
  if (op.startsWith("engine.runtime_") || op.startsWith("engine.game_")) return { op: "engine.game_probe" };
  return { op: "engine.get_scene_tree" };
}

/**
 * Map a failed engine tool call. `guide` is the docs.read id with the tool's
 * full guide and schema (tool/<slug>), the one next step for a bad input.
 */
export function engineFailure(text: string, op: string, options: { effect: "read" | "write"; guide?: string }): Answer {
  const payload = parsePayload(text);
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  // `error` is sometimes a code ("import_failed") and `message` the sentence.
  const sentence = /^[a-z0-9_]+$/.test(str(body?.error) ?? "") ? (str(body?.message) ?? str(body?.error)) : (str(body?.error) ?? str(body?.message));
  const message = (sentence ?? text.split("\n")[0] ?? "").slice(0, 500) || "The engine tool failed.";
  const details = { tool: body ?? text };
  const describe: NextStep = options.guide ? { op: "docs.read", input: { id: options.guide } } : { op: "ops.describe", input: { name: op } };

  const code = str(body?.code) as ErrorCode | undefined;
  const reason = str(body?.failure_reason);
  if (code === "engine_not_running" || NOT_RUNNING.test(text)) return engineNotRunning(code === "engine_not_running" ? str(body?.recovery) : undefined);
  if (SEVERAL_EDITORS.test(text)) return errorAnswer("conflict", message, { next: SEVERAL_EDITORS_STEP, details });
  if (NO_PROJECT.test(text)) return errorAnswer("not_found", message, { next: { say: "Name the folder that holds project.godot, or open the project in Summer Engine." }, details });
  if (code === "engine_lacks_op" || reason === "engine_lacks_op" || reason === "engine_lacks_events" || /engine_lacks_op/.test(text)) {
    return errorAnswer("engine_lacks_op", message, { next: { say: "Update Summer Engine." }, details });
  }
  if (code && PASSED_CODES.has(code)) {
    // A signed-out tool answers with a sign-in link (mcp/tool-results.ts withSignInLink): the next step says it.
    const signIn = code === "not_signed_in" && str(body?.signInUrl) ? { next: { say: str(body?.recovery) ?? `Sign-in link for the person: ${str(body?.signInUrl)}` } } : {};
    return errorAnswer(code, message, { details, ...signIn, ...(code === "invalid_input" ? { next: describe } : {}) });
  }

  if (!body && TRANSPORT.test(text)) {
    return options.effect === "read"
      ? errorAnswer("unavailable", message, { retry: "safe", next: { op: "engine.get_project_context" }, details })
      : errorAnswer("outcome_unknown", `${message} It may have partly applied: read before you retry.`, { retry: "no", next: readAfter(op), details });
  }

  switch (reason) {
    case "invalid_input":
    case "bad_args":
      return errorAnswer("invalid_input", message, { next: describe, details });
    case "unsupported_operation":
      return errorAnswer("unsupported", message, { details });
    case "identity_mismatch":
      return errorAnswer("conflict", message, { next: { op: "engine.get_project_context" }, details });
    case "busy":
      return errorAnswer("in_progress", message, { retry: "after", details: { ...details, retryAfterSeconds: 5 } });
    case "game_not_running":
      return errorAnswer("not_found", message, { next: { op: "engine.play" }, details });
    case "unknown_snapshot":
      return errorAnswer("not_found", message, { next: { op: "engine.world_snapshot" }, details });
    case "not_found":
      return errorAnswer("not_found", message, { details });
  }
  if (/identity_mismatch|registry identity changed/i.test(text)) return errorAnswer("conflict", message, { next: { op: "engine.get_project_context" }, details });
  if (/^[a-z_]*not_found$/.test(str(body?.error) ?? "")) return errorAnswer("not_found", message, { details });
  if (/no scene (is currently )?open|no edited scene/i.test(text)) return errorAnswer("not_found", message, { next: { op: "engine.open_main_scene" }, details });
  if (/not found|does not exist|no such/i.test(message)) return errorAnswer("not_found", message, { details });
  return errorAnswer("invalid_input", message, { next: describe, details });
}

/** The codes a local tool's failure keeps as they are (projects.create_local, projects.open_local). */
const LOCAL_CODES = new Set<ErrorCode>(["engine_not_running", "invalid_input", "not_found", "unavailable", "conflict", "unsupported"]);

/** A local tool's coded failure (`{ok:false, code, error, recovery}`) as the answer, with its recovery as the next step; null when it has no such code. */
export function codedLocalFailure(body: Record<string, unknown>): Answer | null {
  const code = str(body.code) as ErrorCode | undefined;
  if (body.ok !== false || !code || !LOCAL_CODES.has(code)) return null;
  const recovery = str(body.recovery);
  if (code === "engine_not_running") return engineNotRunning(recovery);
  return errorAnswer(code, str(body.error) ?? str(body.message) ?? "The operation failed.", { ...(recovery ? { next: { say: recovery } } : {}), details: { tool: body } });
}

/** A 3.x engine tool's whole result as the answer: its payload on success, the mapped failure otherwise. */
export function answerOfEngineResult(result: unknown, op: string, options: { effect: "read" | "write"; guide?: string }): Answer {
  const [first = "", ...notes] = textsOf(result);
  if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
    return engineFailure([first, ...notes].join("\n\n"), op, options);
  }
  const payload = parsePayload(first) ?? (first ? { text: first } : {});
  return { ok: true, status: "done", result: payload, ...(notes.length ? { warnings: notes } : {}) };
}
