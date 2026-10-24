import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { summerRequestHeaders } from "./agent-host.js";
import { getStoreAccessToken, isSignInGone, OAuthError } from "./oauth.js";
import { resolveGatewayUrl } from "./config.js";

/**
 * The Summer API (www.summerengine.com/v1, PublicSummerEngine
 * src/lib/ops/views/http.ts) from this computer: the curated game-dev models
 * and their prices, an exact estimate, a job, and its files. `summer api` and
 * the summer_api_* MCP tools both call these. Sign-in is the Summer OAuth
 * sign-in on this computer (summer login; core/oauth.ts, refreshed by
 * itself): one Supabase OAuth access token as the bearer. Listing models and
 * estimating need none. There are no API keys.
 *
 * Until Summer opens the API, every route answers 404 "Nothing is here.":
 * that is SummerApiError api_not_open, one plain line for people and agents.
 */

export const API_NOT_OPEN = "Summer API is not open yet.";
export const SIGN_IN_GONE_MESSAGE = 'Your Summer sign-in was revoked or has expired. Run "summer login", then retry.';
const FINISHED = new Set(["done", "failed", "cancelled", "declined", "expired", "stale"]);
/** The longest a --wait follows one job (a 3D model with a rig can take minutes). */
export const MAX_JOB_WAIT_MS = 20 * 60_000;

export class SummerApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly body?: Record<string, unknown>
  ) {
    super(message);
  }
}

export interface SummerApiDependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** The sign-in's current access token (core/oauth.ts); tests pass a fake. */
  token?: () => Promise<string>;
  /** A new access token from the sign-in server now; it throws once the person revoked the app. */
  refresh?: () => Promise<string>;
}

const defaults: SummerApiDependencies = {
  fetch,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
};

export type Job = Record<string, unknown> & { id: string; state: string };

async function call(
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; key?: "required" | "optional" },
  deps: SummerApiDependencies
): Promise<{ status: number; body: Record<string, unknown> }> {
  const key = await (deps.token ?? (() => getStoreAccessToken()))().catch((error: unknown) => {
    if (options.key !== "required") return null;
    if (error instanceof OAuthError) throw new SummerApiError("not_signed_in", 'This computer is not signed in to Summer. Run "summer login", then retry.', 401);
    throw error;
  });
  try {
    return await send(method, path, options, key, deps);
  } catch (error) {
    // Before launch the API answers a refused sign-in the way it answers everyone: "Nothing is here."
    // So check the sign-in itself: a revoked app cannot refresh, and a live one retries once with a new token.
    if (!key || !(error instanceof SummerApiError) || error.code !== "api_not_open") throw error;
    const fresh = await (deps.refresh ?? (() => getStoreAccessToken(undefined, { force: true })))().catch((refused: unknown) => {
      if (isSignInGone(refused)) throw new SummerApiError("sign_in_revoked", SIGN_IN_GONE_MESSAGE, 401);
      throw error;
    });
    return send(method, path, options, fresh, deps);
  }
}

async function send(
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; headers?: Record<string, string> },
  key: string | null,
  deps: SummerApiDependencies
): Promise<{ status: number; body: Record<string, unknown> }> {
  const gateway = await resolveGatewayUrl();
  const res = await deps.fetch(`${gateway}/v1${path}`, {
    method,
    headers: {
      ...summerRequestHeaders(),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(90_000),
  });
  const body = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (res.ok) return { status: res.status, body };
  const error = (body.error && typeof body.error === "object" ? body.error : {}) as Record<string, unknown>;
  const message = typeof error.message === "string" ? error.message : `The Summer API answered ${res.status}.`;
  if (res.status === 404 && (message === "Nothing is here." || !body.error)) throw new SummerApiError("api_not_open", API_NOT_OPEN, 404);
  throw new SummerApiError(typeof error.code === "string" ? error.code : "request_failed", message, res.status, error);
}

/** GET /v1/models (optionally one capability), or one model with GET /v1/models/{id}. */
export async function listModels(
  options: { capability?: string; model?: string } = {},
  overrides: Partial<SummerApiDependencies> = {}
): Promise<Record<string, unknown>> {
  const deps = { ...defaults, ...overrides };
  if (options.model) return (await call("GET", `/models/${options.model.split("/").map(encodeURIComponent).join("/")}`, { key: "optional" }, deps)).body;
  const query = options.capability ? `?capability=${encodeURIComponent(options.capability)}` : "";
  return (await call("GET", `/models${query}`, { key: "optional" }, deps)).body;
}

/** POST /v1/estimate: the exact price of one job, and a quote id that holds it 15 minutes. Charges nothing. */
export async function estimateJob(model: string, input: Record<string, unknown>, overrides: Partial<SummerApiDependencies> = {}): Promise<Record<string, unknown>> {
  return (await call("POST", "/estimate", { body: { model, input }, key: "optional" }, { ...defaults, ...overrides })).body;
}

function jobOf(body: Record<string, unknown>): Job {
  const job = body.job;
  if (!job || typeof job !== "object" || typeof (job as Job).id !== "string") {
    throw new SummerApiError("request_failed", "The Summer API answered without a job.", 502, body);
  }
  return job as Job;
}

export const isFinished = (job: Job) => FINISHED.has(job.state);

/**
 * POST /v1/jobs: spends the person's credits (within the key's limit). One
 * Idempotency-Key per run, so a retried request never runs twice; `waitSeconds`
 * (at most 60) asks the server to answer when the job is done.
 */
export async function runJob(
  model: string,
  input: Record<string, unknown>,
  options: { quoteId?: string; idempotencyKey?: string; waitSeconds?: number } = {},
  overrides: Partial<SummerApiDependencies> = {}
): Promise<Job> {
  const headers: Record<string, string> = { "Idempotency-Key": options.idempotencyKey ?? randomUUID() };
  if (options.waitSeconds) headers.Prefer = `wait=${Math.min(60, Math.max(1, Math.round(options.waitSeconds)))}`;
  const { body } = await call("POST", "/jobs", { body: { model, input, ...(options.quoteId ? { quoteId: options.quoteId } : {}) }, headers, key: "required" }, { ...defaults, ...overrides });
  return jobOf(body);
}

export async function getJob(jobId: string, overrides: Partial<SummerApiDependencies> = {}): Promise<Job> {
  return jobOf((await call("GET", `/jobs/${encodeURIComponent(jobId)}`, { key: "required" }, { ...defaults, ...overrides })).body);
}

export async function cancelJob(jobId: string, overrides: Partial<SummerApiDependencies> = {}): Promise<Job> {
  return jobOf((await call("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, { body: {}, key: "required" }, { ...defaults, ...overrides })).body);
}

/** Follow a job until it finishes or `timeoutMs` passes (then it answers the job as it is). */
export async function waitForJob(job: Job, options: { timeoutMs?: number } = {}, overrides: Partial<SummerApiDependencies> = {}): Promise<Job> {
  const deps = { ...defaults, ...overrides };
  const until = deps.now() + (options.timeoutMs ?? MAX_JOB_WAIT_MS);
  let current = job;
  while (!isFinished(current) && deps.now() < until) {
    const after = typeof current.pollAfterSeconds === "number" ? current.pollAfterSeconds : 5;
    await deps.sleep(Math.min(30, Math.max(2, after)) * 1000);
    current = await getJob(current.id, deps);
  }
  return current;
}

/** Names Windows keeps for devices, with any extension: CON.glb opens the console, not a file. */
const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** <assetId><ext> as a file name every system accepts: no : * ? " < > | (a colon is an NTFS stream), no device name. */
export function jobFileName(assetId: string, fileUrl: string): string {
  const ext = extname(new URL(fileUrl).pathname).slice(0, 8);
  const base = assetId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${WINDOWS_DEVICE_NAMES.test(base.split(".")[0]) ? `_${base}` : base}${/^\.[A-Za-z0-9]+$/.test(ext) ? ext : ".bin"}`;
}

/** The finished job's files: every asset's fileUrl, saved under `dir` as <assetId><ext>. */
export async function downloadJobFiles(job: Job, dir: string, overrides: Partial<SummerApiDependencies> = {}): Promise<string[]> {
  const deps = { ...defaults, ...overrides };
  const result = (job.result && typeof job.result === "object" ? job.result : {}) as Record<string, unknown>;
  const assets = (Array.isArray(result.assets) ? result.assets : []) as Array<Record<string, unknown>>;
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  const saved: string[] = [];
  for (const [index, asset] of assets.entries()) {
    if (typeof asset.fileUrl !== "string") continue;
    const res = await deps.fetch(asset.fileUrl, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new SummerApiError("download_failed", `Could not download ${asset.fileUrl} (${res.status}).`, res.status);
    const path = join(target, jobFileName(String(asset.assetId ?? `${job.id}-${index + 1}`), asset.fileUrl));
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    saved.push(path);
  }
  return saved;
}

/** One job of a batch: one line of a --batch file, one item of summer_api_batch. */
export interface BatchJob {
  model: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
}

export type Batch = Record<string, unknown> & { id: string; jobs: Job[]; counts?: Record<string, number> };

/** The most jobs one POST /v1/batches takes. */
export const MAX_BATCH_JOBS = 500;
/** The longest a --wait follows one batch (it runs on the account's slots, in order). */
export const MAX_BATCH_WAIT_MS = 2 * 60 * 60_000;

function batchJobOf(value: unknown, where: string): BatchJob {
  const item = (value && typeof value === "object" && !Array.isArray(value) ? value : null) as Record<string, unknown> | null;
  if (!item || typeof item.model !== "string" || !item.model) throw new SummerApiError("invalid_input", `${where}: needs "model", e.g. {"model": "3d/default", "input": {"prompt": "a wooden chest"}}.`, 400);
  const input = item.input ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SummerApiError("invalid_input", `${where}: "input" must be a JSON object.`, 400);
  const key = item.idempotencyKey ?? item.idempotency_key;
  if (key !== undefined && (typeof key !== "string" || !key)) throw new SummerApiError("invalid_input", `${where}: "idempotencyKey" must be a string.`, 400);
  return { model: item.model, input: input as Record<string, unknown>, ...(typeof key === "string" ? { idempotencyKey: key } : {}) };
}

/** A JSONL batch: one job per line ({"model", "input", optional "idempotencyKey"}); blank lines are skipped. */
export function parseBatchLines(text: string): BatchJob[] {
  const jobs: BatchJob[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new SummerApiError("invalid_input", `Line ${index + 1} is not JSON.`, 400);
    }
    jobs.push(batchJobOf(value, `Line ${index + 1}`));
  }
  return checkBatch(jobs);
}

/** The same checks for jobs that came as a list (summer_api_batch). */
export function checkBatch(jobs: unknown[]): BatchJob[] {
  if (jobs.length === 0) throw new SummerApiError("invalid_input", "The batch has no jobs.", 400);
  if (jobs.length > MAX_BATCH_JOBS) throw new SummerApiError("invalid_input", `The batch has ${jobs.length} jobs; one batch takes at most ${MAX_BATCH_JOBS}.`, 400);
  return jobs.map((job, index) => batchJobOf(job, `Job ${index + 1}`));
}

function batchOf(body: Record<string, unknown>): Batch {
  const batch = body.batch;
  if (!batch || typeof batch !== "object" || typeof (batch as Batch).id !== "string") {
    throw new SummerApiError("request_failed", "The Summer API answered without a batch.", 502, body);
  }
  return batch as Batch;
}

export async function getBatch(batchId: string, overrides: Partial<SummerApiDependencies> = {}): Promise<Batch> {
  return batchOf((await call("GET", `/batches/${encodeURIComponent(batchId)}`, { key: "required" }, { ...defaults, ...overrides })).body);
}

/**
 * POST /v1/batches: up to 500 jobs, all or none. Each is priced first; when
 * the paid credits and the app's limit cover them all, all are queued (202)
 * and run in order on the account's slots. When not, nothing runs and the
 * error (402) says how many fit and how much more is needed. One
 * Idempotency-Key for the batch, so a retried request never queues it twice.
 */
export async function createBatch(
  jobs: BatchJob[],
  options: { idempotencyKey?: string } = {},
  overrides: Partial<SummerApiDependencies> = {}
): Promise<Batch> {
  const deps = { ...defaults, ...overrides };
  const headers = { "Idempotency-Key": options.idempotencyKey ?? randomUUID() };
  const batch = batchOf((await call("POST", "/batches", { body: { jobs }, headers, key: "required" }, deps)).body);
  // A replayed batch answers its job count only: read its jobs.
  return Array.isArray(batch.jobs) ? batch : getBatch(batch.id, deps);
}

export const isBatchFinished = (batch: Batch) => batch.jobs.length > 0 && batch.jobs.every(isFinished);

/** Follow a batch until every job finishes or `timeoutMs` passes (then it answers the batch as it is). */
export async function waitForBatch(batch: Batch, options: { timeoutMs?: number } = {}, overrides: Partial<SummerApiDependencies> = {}): Promise<Batch> {
  const deps = { ...defaults, ...overrides };
  const until = deps.now() + (options.timeoutMs ?? MAX_BATCH_WAIT_MS);
  let current = batch;
  while (!isBatchFinished(current) && deps.now() < until) {
    await deps.sleep(10_000);
    current = await getBatch(current.id, deps);
  }
  return current;
}

/** Every done job's files under `dir`, by job id. */
export async function downloadBatchFiles(batch: Batch, dir: string, overrides: Partial<SummerApiDependencies> = {}): Promise<Record<string, string[]>> {
  const files: Record<string, string[]> = {};
  for (const job of batch.jobs) {
    if (job.state === "done") files[job.id] = await downloadJobFiles(job, dir, overrides);
  }
  return files;
}

/** summer_api_batch: follow when asked (within one call's time), save files when `out` is given. */
export async function batchToolResult(batch: Batch, args: { wait?: boolean; out?: string }, overrides: Partial<SummerApiDependencies> = {}): Promise<Record<string, unknown>> {
  const follow = args.wait === true || typeof args.out === "string";
  const final = follow && !isBatchFinished(batch) ? await waitForBatch(batch, { timeoutMs: TOOL_JOB_WAIT_MS }, overrides) : batch;
  const files = typeof args.out === "string" ? await downloadBatchFiles(final, args.out, overrides) : undefined;
  return {
    batch: final,
    ...(files ? { files } : {}),
    ...(isBatchFinished(final) ? {} : { next: `Call summer_api_batch with batchId ${final.id} (wait: true${typeof args.out === "string" ? ", out" : ""}) to keep following it.` }),
  };
}

/** The answer the summer_api_* MCP tools (and `summer tool api-*`) give: the result, or {ok:false, error}. */
export async function summerApiToolAnswer(work: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return { ok: true, ...(await work()) };
  } catch (error) {
    if (error instanceof SummerApiError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "request_failed", message: error instanceof Error ? error.message : String(error) } };
  }
}

/** One MCP call waits at most this long for a job; then it answers the job as it is (call summer_api_job to keep following). */
export const TOOL_JOB_WAIT_MS = 50_000;

/** summer_api_run and summer_api_job: follow when asked (within one call's time), save files when `out` is given. */
export async function jobToolResult(job: Job, args: { wait?: boolean; out?: string }, overrides: Partial<SummerApiDependencies> = {}): Promise<Record<string, unknown>> {
  const follow = args.wait === true || typeof args.out === "string";
  const final = follow && !isFinished(job) ? await waitForJob(job, { timeoutMs: TOOL_JOB_WAIT_MS }, overrides) : job;
  const files = typeof args.out === "string" && final.state === "done" ? await downloadJobFiles(final, args.out, overrides) : undefined;
  return { job: final, ...(files ? { files } : {}), ...(isFinished(final) ? {} : { next: `Call summer_api_job with jobId ${final.id} (wait: true) to keep following it.` }) };
}
