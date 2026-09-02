/**
 * Per-project routing layer — shared contract types.
 *
 * A ProjectConnection is a uniform handle to "whatever process currently
 * serves this project": either the live editor (today's HTTP transport,
 * unchanged) or a headless worker (TCP newline-delimited JSON).
 *
 * This module is deliberately self-contained: nothing under src/core/headless/ is
 * imported by the existing MCP/CLI code paths except behind the opt-in env
 * flag SUMMER_HEADLESS_ROUTING=1 (see src/mcp/server.ts getClient and
 * ./mcp-routing.ts). See docs/HEADLESS_ROUTING.md for the full
 * contract this implements.
 */

export type ProjectConnectionKind = "editor" | "worker";

/** Stage that failed, for structured timeout/transport errors. */
export type HeadlessStage =
  | "connect" // TCP connect to the worker port
  | "auth" // auth line + ping verification
  | "op" // an in-flight request (inactivity: no response AND no progress)
  | "spawn"; // spawned worker never appeared in the registry

/**
 * Timeout (and stage-tagged failure) error for the headless layer. `stage`
 * names exactly which step gave up, so callers and logs can distinguish
 * "could not reach the worker" from "the worker went quiet mid-import".
 * NEVER put tokens in these messages — they surface verbatim in tool results.
 */
export class HeadlessTimeoutError extends Error {
  readonly stage: HeadlessStage;
  constructor(stage: HeadlessStage, message: string) {
    super(`[headless:${stage}] ${message}`);
    this.name = "HeadlessTimeoutError";
    this.stage = stage;
  }
}

/** Read a positive-integer env override with a sane default. */
export function envMs(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Ops that may legitimately run for minutes (first import, game boot). */
export const LONG_RUNNING_OPS: ReadonlySet<string> = new Set([
  "import",
  "game.run",
]);

/** Ops that MUTATE project or process state. When one of these times out the
 *  connection is QUARANTINED (destroyed + evicted via credentialsChanged)
 *  because the mutation's outcome is UNKNOWN and a blind retry could
 *  double-apply. Read-only ops that time out leave the connection usable. */
export const MUTATING_OPS: ReadonlySet<string> = new Set([
  "import",
  "fs.write",
  "game.run",
  "game.stop",
]);

/**
 * Remove secret material from any string that can reach an error message or
 * log line. Applied to worker-supplied error text and spawn stderr tails —
 * defense in depth on top of "the raw token never crosses the wire" (v1.1
 * mutual auth) and "this module never interpolates tokens itself".
 */
export function scrubSecrets(
  text: string,
  secrets: ReadonlyArray<string | undefined>
): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      scrubbed = scrubbed.split(secret).join("[redacted]");
    }
  }
  return scrubbed;
}

/**
 * Error for an op the WORKER answered with ok:false. `code` is the leading
 * snake_case classifier when the worker sent a structured error (e.g.
 * "sha256_mismatch: content changed since read", "already_exists",
 * "needs_display"), so guard failures are distinguishable from generic
 * transport throws.
 */
export class WorkerOpError extends Error {
  readonly code?: string;
  constructor(message: string) {
    super(message);
    this.name = "WorkerOpError";
    const match = /^([a-z][a-z0-9_]*)(?::|$)/.exec(message);
    if (match) this.code = match[1];
  }
}

export interface CallOptions {
  /** Client-side INACTIVITY budget for this op: the timer restarts on every
   *  progress line, so a chatty long import stays alive while a silent hang
   *  still fails. Defaults: SUMMER_WORKER_OP_TIMEOUT_MS (30s) for normal ops,
   *  SUMMER_WORKER_LONG_OP_TIMEOUT_MS (300s) for LONG_RUNNING_OPS. */
  timeoutMs?: number;
  /** Interim progress lines ({"id","event":"progress","progress"}) for this
   *  request are surfaced here. Editor connections never emit progress. */
  onProgress?: (progress: unknown) => void;
}

/**
 * Uniform per-project backend handle.
 *
 * `call(op, params)` uses the WORKER op vocabulary as the canonical surface:
 *   ping, status, import, fs.list, fs.read, fs.write, uid.resolve,
 *   scene.read, game.run, game.stop, game.logs, game.screenshot
 * EditorConnection adapts that vocabulary onto the existing EngineApiClient;
 * WorkerConnection speaks it natively over TCP.
 */
export interface ProjectConnection {
  readonly kind: ProjectConnectionKind;
  /** Canonical absolute project path this connection serves. */
  readonly projectPath: string;
  call(
    op: string,
    params?: Record<string, unknown>,
    options?: CallOptions
  ): Promise<unknown>;
  /** True while the underlying transport is usable. A dropped worker socket
   *  flips this to false permanently — reconnect-on-drop is NOT attempted;
   *  callers re-resolve via resolveProjectConnection instead. */
  isAlive(): boolean;
  close(): void;
}

/** Ops the headless worker implements (mirror of the worker agent's brief). */
export const WORKER_OPS = [
  "ping",
  "status",
  "import",
  "fs.list",
  "fs.read",
  "fs.write",
  "uid.resolve",
  "scene.read",
  "game.run",
  "game.stop",
  "game.logs",
  "game.screenshot",
] as const;

export type WorkerOp = (typeof WORKER_OPS)[number];
