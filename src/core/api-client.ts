import { mkdir, readdir, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "node:crypto";
import {
  getApiToken,
  getApiPort,
  checkEngineHealth,
  resolveEngineConnection,
  type EngineHealth,
  type EngineSelection,
} from "./engine.js";
import type { EngineCapabilities } from "./capability-skew.js";
import { asRecord, boolFrom, numberFrom, stringFrom } from "./util/json.js";
import {
  classifyOpsResponse,
  pollOpToTerminal,
  type OpResultEnvelope,
} from "./async-op-lifecycle.js";
import { pickPlayDeterminism, type PlayDeterminism } from "./capabilities/play-determinism.js";

export type EngineSnapshot = {
  ok: boolean;
  localPath?: string;
  path?: string;
  /** Raw image bytes, base64-encoded. Carried so a caller (e.g. the MCP
   *  screenshot tool) can return an MCP image content block to a vision-capable
   *  client without re-reading localPath off disk. */
  base64?: string;
  width?: number;
  height?: number;
  format?: string;
  mime?: string;
  context?: string;
  op?: string;
  provenance?: unknown;
  bytes?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  /** Structured failure classifier the engine returns on a game snapshot over
   *  local HTTP (409 `bridge_required`) — surfaced verbatim so the tool can give
   *  an honest, actionable message instead of a truncated generic 409 string.
   *  When P4.4 lands (game snapshots answer 200/202 over HTTP) this simply
   *  never fires and the tool works. */
  failureReason?: string;
  /** Scene-preview confession fields (P4.3). Populated only for target:"scene".
   *  A scene with no Camera3D renders grey/black when played; the engine reports
   *  whether it had to synthesize a camera/light so the model can warn honestly. */
  sceneHasCamera?: boolean;
  sceneHadLight?: boolean;
  usedSyntheticCamera?: boolean;
  /** Scene-preview only: the framing the engine actually rendered with
   *  ("auto" resolves to "iso"). */
  framing?: string;
  /** Scene-preview only: path (relative to the scene root) of the node the
   *  camera framed when nodePath was given. */
  framedNode?: string;
  /** Scene-preview only: how many blank-readback retries the engine needed
   *  before the capture produced a non-blank frame (0 = clean first read). */
  renderRetries?: number;
  /** Set true when the bound projectIdHash no longer matches the engine's live
   *  health hash at capture time — the frame may be from the WRONG project
   *  (item 4, client-side drift check). */
  projectMismatch?: boolean;
};

type SnapshotPayload = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  failure_reason?: string;
  base64?: string;
  image_base64?: string;
  width?: number;
  height?: number;
  format?: string;
  mime?: string;
  context?: string;
  op?: string;
  provenance?: unknown;
  scene_has_camera?: boolean;
  scene_had_light?: boolean;
  used_synthetic_camera?: boolean;
  framing?: string;
  framed_node?: string;
  render_retries?: number;
};

type EngineTargetIdentity = {
  instanceId?: string;
  projectId?: string;
  projectIdHash?: string;
};

/** Query parameters of GET /api/events/poll (the engine's events channel). */
export type EventsPollParams = {
  /** Deliver events with seq > since. Omitted = live only (from the newest
   *  seq at request time); 0 = replay the whole retained ring. A value beyond
   *  the newest seq is clamped by the engine so the caller resyncs. */
  since?: number;
  /** Allow-list of event kinds (op.applied, play.started, ...); omitted or
   *  empty = every kind. */
  kinds?: string[];
  /** Max ms the engine holds the request before answering with zero events
   *  (engine default 25000, cap 60000; 0 = answer immediately). */
  wait?: number;
  /** Max events per answer (engine default 100, cap 500); the answer says
   *  truncated:true when the page was full. */
  limit?: number;
};

function findSnapshotPayload(value: unknown): SnapshotPayload | null {
  const record = asRecord(value);
  if (!record) return null;

  if (
    typeof record.base64 === "string" ||
    typeof record.image_base64 === "string" ||
    record.op === "ViewportSnapshot" ||
    record.op === "GameSnapshot" ||
    record.op === "ScenePreview"
  ) {
    return record as SnapshotPayload;
  }

  if (Array.isArray(record.results)) {
    for (const result of record.results) {
      const payload = findSnapshotPayload(result);
      if (payload) return payload;
    }
  }

  return findSnapshotPayload(record.data);
}

function snapshotFormat(payload: Pick<SnapshotPayload, "format" | "mime">): {
  format: string;
  mime: string;
  ext: string;
} {
  const explicitMime = stringFrom(payload.mime)?.toLowerCase();
  const explicitFormat = stringFrom(payload.format)?.toLowerCase();
  const format =
    explicitFormat ??
    (explicitMime?.includes("png")
      ? "png"
      : explicitMime?.includes("webp")
        ? "webp"
        : "jpeg");
  const mime =
    explicitMime ??
    (format === "png"
      ? "image/png"
      : format === "webp"
        ? "image/webp"
        : "image/jpeg");
  const ext = format === "jpeg" ? "jpg" : format;
  return { format, mime, ext };
}

function withoutImageData(payload: SnapshotPayload): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "base64" && key !== "image_base64") {
      metadata[key] = value;
    }
  }
  return metadata;
}

/** rebind() could not re-read engine health; the session identity is unchanged. */
export class EngineRebindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineRebindError";
  }
}

const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Snapshot files otherwise accumulate in tmpdir for the life of the machine.
 * Remove those older than 24h on each write. Best-effort by contract: a
 * failed reap must never fail (or slow down) the capture that triggered it.
 */
async function reapStaleSnapshots(dir: string): Promise<void> {
  try {
    const cutoff = Date.now() - SNAPSHOT_TTL_MS;
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      try {
        const info = await stat(full);
        if (info.isFile() && info.mtimeMs < cutoff) await rm(full, { force: true });
      } catch {
        // per-file failure (raced by another process, permissions): skip it
      }
    }
  } catch {
    // unreadable directory: nothing to reap
  }
}

export class EngineApiClient {
  private port: number;
  private token: string;
  // The engine and project this session is bound to. Every request carries the
  // identity captured from health so the engine can reject requests after an
  // in-place project switch or an unexpected instance change. The string form
  // preserves the pre-2.6.6 constructor contract for existing callers that only
  // supplied a projectIdHash.
  private targetIdentity: EngineTargetIdentity;
  private selection: EngineSelection | null;
  // The most recent /api/health seen at connect/rebind. Carries the engine's
  // capability advert (opKinds, singleOnlyOps) so tools can fail closed on a
  // provably missing op without a second health round trip per call.
  private lastHealth: EngineHealth | null = null;

  constructor(
    port: number,
    token: string,
    targetIdentity: EngineTargetIdentity | string = {},
    selection: EngineSelection | null = null
  ) {
    this.port = port;
    this.token = token;
    this.targetIdentity =
      typeof targetIdentity === "string"
        ? { projectIdHash: targetIdentity }
        : { ...targetIdentity };
    this.selection = selection ? { ...selection } : null;
  }

  static async connect(
    selection?: EngineSelection
  ): Promise<EngineApiClient> {
    if (selection) {
      const connection = await resolveEngineConnection(selection);
      const client = new EngineApiClient(
        connection.port,
        connection.token,
        {
          instanceId: connection.health.instanceId,
          projectId: connection.health.projectId,
          projectIdHash: connection.health.projectIdHash,
        },
        { ...selection }
      );
      client.lastHealth = connection.health;
      return client;
    }

    const port = await getApiPort();
    const token = await getApiToken();

    if (!token) {
      throw new Error(
        "Summer Engine is not running (no api-token found). Open Summer Engine first."
      );
    }

    const health = await checkEngineHealth(port);
    if (!health) {
      throw new Error(
        `Summer Engine is not responding on port ${port}. Make sure it's open.`
      );
    }

    // Bind to whatever project is open right now. On a genuine engine restart the
    // token rotates and getClient() rebuilds this client, so a restart naturally
    // rebinds to the current project. An in-place project switch keeps the same
    // token, so the cached client retains its original binding and the engine
    // rejects mismatched mutations until the agent explicitly rebinds.
    const client = new EngineApiClient(port, token, {
      instanceId: health.instanceId,
      projectId: health.projectId,
      projectIdHash: health.projectIdHash,
    });
    client.lastHealth = health;
    return client;
  }

  /** The engine's capability advert from the last health read (connect or
   *  rebind), or undefined when the engine predates the advert. */
  getEngineCapabilities(): EngineCapabilities | undefined {
    return this.lastHealth?.capabilities;
  }

  /** Engine version string from the last health read, for skew messages. */
  getEngineVersion(): string | undefined {
    return this.lastHealth?.version;
  }

  /** The projectIdHash this session is bound to (undefined if none was reported
   *  at connect — e.g. no project open yet). */
  getBoundProjectIdHash(): string | undefined {
    return this.targetIdentity.projectIdHash;
  }

  /**
   * Re-read health and rebind to the currently-open project. Called by
   * summer_get_project_context so the agent can INTENTIONALLY follow a project
   * switch (the deliberate escape hatch after an identity_mismatch). Returns the
   * new bound hash. The direct health probe is intentionally unscoped, so it can
   * reach the current engine even when bound requests would be rejected.
   *
   * Throws EngineRebindError when the health probe fails: the previous identity
   * is kept, and reporting it as "the rebound hash" would tell the agent a
   * switch it never followed had succeeded.
   */
  async rebind(): Promise<string | undefined> {
    const health = await checkEngineHealth(this.port);
    if (!health) {
      throw new EngineRebindError(
        `Summer Engine did not answer the health probe on port ${this.port}; this session is still bound to ${
          this.targetIdentity.projectIdHash ?? "no project"
        }. Recovery: confirm the engine is running with the project open, then call summer_get_project_context again.`
      );
    }
    this.lastHealth = health;
    this.targetIdentity = {
      instanceId: health.instanceId,
      projectId: health.projectId,
      projectIdHash: health.projectIdHash,
    };
    return this.targetIdentity.projectIdHash;
  }

  /** Identity to attach to a MUTATING command's options so the engine can reject
   *  a wrong-project write. Empty when unbound (engine then skips the check). */
  private identityOptions(): Record<string, unknown> {
    const projectIdHash = this.targetIdentity.projectIdHash;
    return projectIdHash ? { projectIdHash } : {};
  }

  private requireBoundIdentity(): Record<string, unknown> {
    const { instanceId, projectId, projectIdHash } = this.targetIdentity;
    if (!instanceId || !projectId || !projectIdHash) {
      throw new Error(
        "Safe project mutation requires a complete engine/project identity. Call summer_get_project_context to bind this MCP session, then retry. Nothing was written."
      );
    }
    return { projectIdHash };
  }

  private targetUrl(path: string): string {
    const url = new URL(path, `http://127.0.0.1:${this.port}`);
    const { instanceId, projectId, projectIdHash } = this.targetIdentity;

    if (instanceId) url.searchParams.set("instanceId", instanceId);
    if (projectId) url.searchParams.set("projectId", projectId);
    if (projectIdHash) url.searchParams.set("projectIdHash", projectIdHash);
    if (instanceId && projectId && projectIdHash) {
      url.searchParams.set("projectIdentityVersion", "1");
    }

    return url.toString();
  }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const url = this.targetUrl(path);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Engine API error ${res.status}: ${text.slice(0, 200)}`);
    }

    try {
      return await res.json();
    } catch {
      // A bare SyntaxError names nothing; say which request answered with a
      // non-JSON body (a proxy page, an HTML error, a half-written stream).
      throw new Error(
        `Engine API returned a non-JSON response for ${method} ${path} (HTTP ${res.status}).`
      );
    }
  }

  /** Raw fetch with auth + timeout — returns the Response so callers can inspect
   *  the status (202 queued vs 200 legacy). */
  private async _fetchRaw(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<Response> {
    return fetch(this.targetUrl(path), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** One long-poll of GET /api/ops/result (up to waitMs). */
  private async _pollResult(requestId: string, waitMs: number): Promise<OpResultEnvelope> {
    const res = await this._fetchRaw(
      "GET",
      `/api/ops/result?requestId=${encodeURIComponent(requestId)}&wait=${waitMs}`,
      undefined,
      waitMs + 5000
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Engine API error ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as OpResultEnvelope;
  }

  /**
   * Block E: send a mutating request, then resolve EITHER the legacy synchronous
   * result (HTTP 200 — dormant/older engine) OR the async lifecycle (202
   * {requestId} -> long-poll /api/ops/result until terminal). Compatible with
   * both — inspects the HTTP status, not a flag. `timeoutMs` is the poll loop's
   * client wait budget; expiry preserves the requestId and last known lifecycle
   * state instead of pretending the accepted operation did not apply.
   */
  private async _requestQueued(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    // Mint the request ID before submission. If the acknowledgement or a later
    // poll is lost, callers retain the exact identity needed to reconcile the
    // accepted lifecycle instead of issuing an unsafe blind retry.
    let clientRequestId: string | undefined;
    let requestBody = body;
    if (method === "POST") {
      const bodyRecord = asRecord(body) ?? {};
      const existingOptions = asRecord(bodyRecord.options) ?? {};
      clientRequestId =
        stringFrom(existingOptions.requestId) ?? `mcp-${randomUUID()}`;
      requestBody = {
        ...bodyRecord,
        options: {
          ...existingOptions,
          requestId: clientRequestId,
        },
      };
    }

    let res: Response;
    try {
      res = await this._fetchRaw(method, path, requestBody, timeoutMs);
    } catch (error) {
      if (!clientRequestId) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Summer Engine did not acknowledge request ${clientRequestId}; dispatch state is unknown. Do not retry blindly. ${detail}`
      );
    }
    return this._resolveQueuedResponse(res, clientRequestId, timeoutMs);
  }

  /**
   * The post-submission half of _requestQueued: classify an already-fetched
   * response (200 legacy / 202 queued / 429 backpressure) and, for 202, poll
   * the accepted requestId to its terminal receipt. Split out so a caller that
   * has to inspect the raw status first (gameSnapshot's 409 bridge check) can
   * feed its ONE response in here instead of issuing a second request.
   */
  private async _resolveQueuedResponse(
    res: Response,
    clientRequestId: string | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    // 202 (queued) + 429 (backpressure, errorClass in body) are handled below;
    // any other non-2xx is a real transport error.
    if (!res.ok && res.status !== 202 && res.status !== 429) {
      const text = await res.text().catch(() => "");
      const suffix = clientRequestId ? ` (requestId ${clientRequestId})` : "";
      throw new Error(`Engine API error ${res.status}${suffix}: ${text.slice(0, 200)}`);
    }
    const respBody = await res.json().catch(() => ({}));
    const classified = classifyOpsResponse(res.status, respBody);
    if (classified.mode === "legacy") {
      if (res.status === 429) {
        return {
          ...(asRecord(respBody) ?? {}),
          requestId: clientRequestId,
          terminalState: stringFrom(asRecord(respBody)?.terminalState) ?? "queue_full",
          dispatchState: "not_sent",
        };
      }
      return respBody;
    }
    // The acknowledgement is authoritative for polling. Current engines echo
    // the client-generated ID, while older engines may ignore options.requestId
    // and mint their own; polling the submitted ID against those engines would
    // wait forever on an unknown lifecycle.
    const acceptedRequestId = classified.requestId || clientRequestId;
    if (!acceptedRequestId) {
      return {
        status: "error",
        error: "Summer Engine accepted an operation without returning a requestId; final state is uncertain.",
        terminalState: "uncertain",
        errorClass: "transient",
        dispatchState: "uncertain",
      };
    }
    try {
      const terminal = await pollOpToTerminal(
        (waitMs) => this._pollResult(acceptedRequestId, waitMs),
        {
          totalTimeoutMs: timeoutMs,
          requestId: acceptedRequestId,
        }
      );
      if (clientRequestId && clientRequestId !== acceptedRequestId) {
        terminal.submissionRequestId = clientRequestId;
      }
      return terminal;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        status: "error",
        error:
          `Summer Engine accepted request ${acceptedRequestId}, but its final receipt could not be retrieved. ` +
          `The operation may still be running or may already have applied; inspect the target before retrying. ${detail}`,
        terminalState: "uncertain",
        errorClass: "transient",
        dispatchState: "uncertain",
        requestId: acceptedRequestId,
        ...(clientRequestId && clientRequestId !== acceptedRequestId
          ? { submissionRequestId: clientRequestId }
          : {}),
        lastKnownStatus: "unknown",
      };
    }
  }

  async health(): Promise<unknown> {
    return this.request("GET", "/api/health");
  }

  /**
   * One long-poll of GET /api/events/poll (the engine's events channel). The
   * engine answers on the first event matching `kinds` with seq > `since`, or
   * after `wait` ms with `timed_out:true`; a 2xx is the poll envelope
   * {ok, events:[{seq, kind, ts, data}], next_seq, last_seq, since, truncated,
   * timed_out}. Identity-gated like every other route: the bound project rides
   * in the query, so a wrong project answers 409 identity_mismatch.
   *
   * The three answers this route documents — 404 (no channel on this build),
   * 409 (identity mismatch), 503 (bus not started) — come back as a STRUCTURED
   * failure {ok:false, http_status, ...body} so both faces classify them (a
   * terminalState keeps its standard message and rebind hint; the events
   * capability rewrites a 404 into engine_lacks_events). Anything else throws
   * like every other request, so a stale-token 401/403 still triggers
   * withEngine's reconnect-and-retry.
   */
  async pollEvents(params: EventsPollParams = {}, timeoutMs?: number): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.since !== undefined) query.set("since", String(params.since));
    if (params.kinds && params.kinds.length > 0) query.set("kinds", params.kinds.join(","));
    if (params.wait !== undefined) query.set("wait", String(params.wait));
    if (params.limit !== undefined) query.set("limit", String(params.limit));
    // URLSearchParams.size is undefined on Node < 18.16; stringify instead.
    const suffix = query.toString();
    const path = `/api/events/poll${suffix ? `?${suffix}` : ""}`;
    // The engine holds the request up to `wait` ms; give the socket headroom.
    const wait = params.wait ?? 25_000;
    const res = await this._fetchRaw("GET", path, undefined, timeoutMs ?? wait + 5_000);
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new Error(
          `Engine API returned a non-JSON response for GET /api/events/poll (HTTP ${res.status}).`
        );
      }
    }
    const text = await res.text().catch(() => "");
    if (res.status === 404 || res.status === 409 || res.status === 503) {
      let body: Record<string, unknown> = {};
      try {
        body = asRecord(JSON.parse(text)) ?? {};
      } catch {
        // non-JSON body (an HTML 404 page): keep the raw text below
      }
      const failure: Record<string, unknown> = { ok: false, ...body, http_status: res.status };
      if (typeof failure.error !== "string" && typeof failure.terminalState !== "string") {
        failure.error = `Engine API error ${res.status}: ${text.slice(0, 200)}`;
      }
      return failure;
    }
    throw new Error(`Engine API error ${res.status}: ${text.slice(0, 200)}`);
  }

  async executeOps(
    ops: Record<string, unknown>[],
    options?: Record<string, unknown>,
    timeoutMs = 120_000
  ): Promise<unknown> {
    // Ops may include long-running work (ImportFromUrlBatch, GitCommit); the
    // engine keeps it "running" and we poll. 120s budget by default; ops that
    // declare a longer server-side max_seconds (RunEditorScript) pass a larger
    // timeoutMs so the client never gives up before the engine can finish.
    // Resolves legacy-200 or async-202 (Block E).
    // Attach the bound project identity so the engine rejects a write aimed at a
    // different project (identity_mismatch, atomic — before any op applies).
    const merged = { ...(options ?? {}), ...this.identityOptions() };
    const body = Object.keys(merged).length ? { ops, options: merged } : { ops };
    return this._requestQueued("POST", "/api/ops", body, timeoutMs);
  }

  /**
   * Mutation path for MCP file tools. Unlike legacy executeOps callers, this
   * fails closed when health did not provide a complete target identity. The
   * bound hash is stamped last so a caller cannot override it in options.
   */
  async executeIdentityBoundOps(
    ops: Record<string, unknown>[],
    options?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown> {
    const identity = this.requireBoundIdentity();
    return this.executeOps(ops, { ...(options ?? {}), ...identity }, timeoutMs);
  }

  async readProjectFile(path: string, maxBytes = 200_000): Promise<unknown> {
    const query = new URLSearchParams({
      path,
      maxBytes: String(maxBytes),
    });
    return this.request("GET", `/api/state/read-file?${query.toString()}`);
  }

  async getSceneState(
    scenePath?: string,
    options?: { depth?: number; limit?: number }
  ): Promise<unknown> {
    // depth/limit only take effect on targeted (scene=) reads: the engine
    // routes those through the live command queue and forwards every query
    // param into StateProvider::scene_state (tool_net_thread.cpp
    // _parse_state_args). An UNtargeted read is answered from a pre-published
    // snapshot built with the defaults (depth 2, limit 200) and its query
    // params are ignored — callers who need depth/limit must pass scenePath
    // (summer_get_scene_tree resolves the current scene path for this).
    const parts: string[] = [];
    if (scenePath) parts.push(`scene=${encodeURIComponent(scenePath)}`);
    if (options?.depth !== undefined) parts.push(`depth=${options.depth}`);
    if (options?.limit !== undefined) parts.push(`limit=${options.limit}`);
    const query = parts.length ? `?${parts.join("&")}` : "";
    return this.request("GET", `/api/state/scene${query}`);
  }

  async getProjectState(prefix?: string): Promise<unknown> {
    // ?prefix= is sent for forward-compatibility, but current engine builds
    // IGNORE it: /api/state/project is always served from the snapshot, which
    // is published with empty args (local_api_server.cpp
    // _maybe_publish_snapshot), so StateProvider::project_state never sees the
    // query. Callers that need a prefix subset must also filter client-side
    // (summer_get_project_context does).
    const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
    return this.request("GET", `/api/state/project${query}`);
  }

  async getDiagnostics(): Promise<unknown> {
    return this.request("GET", "/api/state/diagnostics");
  }

  async inspectNode(path: string): Promise<unknown> {
    return this.request("GET", `/api/state/inspector?path=${encodeURIComponent(path)}`);
  }

  async inspectResource(path: string): Promise<unknown> {
    return this.request("GET", `/api/state/resource?path=${encodeURIComponent(path)}`);
  }

  async getScriptErrors(path: string): Promise<unknown> {
    return this.request("GET", `/api/state/script-errors?path=${encodeURIComponent(path)}`);
  }

  async play(scene?: string, determinism?: PlayDeterminism): Promise<unknown> {
    // Cold-load on large projects can take 25-40s. 60s budget.
    const pins = pickPlayDeterminism(determinism);
    if (pins) {
      // Determinism params (seed / fixed_fps / time_scale) — the /api/play rung
      // copies ONLY `scene` from options into the PlayGame op
      // (local_api_server.cpp play branch), so a pinned launch travels as an
      // explicit PlayGame op through /api/ops. executeOps stamps the bound
      // identity like every other op. An engine that predates the params
      // ignores the extra keys and answers the v1 result (no `determinism`).
      return this.executeOps([{ op: "PlayGame", ...(scene ? { scene } : {}), ...pins }], undefined, 60_000);
    }
    // The engine reads play params from body.options (tool_net_thread.cpp:503),
    // and the play handler reads options["scene"] — a top-level { scene } is
    // dropped, so the scene MUST be nested inside options. The bound identity
    // rides in the same options dict so play is refused on a mismatched project.
    const options = { ...this.identityOptions(), ...(scene ? { scene } : {}) };
    return this._requestQueued(
      "POST",
      "/api/play",
      Object.keys(options).length ? { options } : {},
      60_000
    );
  }

  async stop(): Promise<unknown> {
    const options = this.identityOptions();
    return this._requestQueued(
      "POST",
      "/api/stop",
      Object.keys(options).length ? { options } : undefined,
      15_000
    );
  }

  async readFile(
    path: string,
    maxBytes?: number
  ): Promise<unknown> {
    const params = new URLSearchParams({ path });
    if (maxBytes) params.set("maxBytes", String(maxBytes));
    return this.request("GET", `/api/state/read-file?${params}`);
  }

  async getFsTree(
    root = "res://",
    limit = 2000
  ): Promise<unknown> {
    const params = new URLSearchParams({
      root,
      limit: String(limit),
    });
    return this.request("GET", `/api/state/fs-tree?${params}`);
  }

  async getSelection(): Promise<unknown> {
    return this.request("GET", "/api/state/selection");
  }

  private async writeSnapshotFile(
    kind: "viewport" | "game" | "scene",
    buffer: Buffer,
    ext: string
  ): Promise<string> {
    const dir = join(tmpdir(), "summer-engine", "snapshots");
    await mkdir(dir, { recursive: true });
    await reapStaleSnapshots(dir);
    const filename = `${kind}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`;
    const localPath = join(dir, filename);
    await writeFile(localPath, buffer);
    return localPath;
  }

  private async snapshot(kind: "viewport" | "game"): Promise<EngineSnapshot> {
    // Block E: /api/snapshot/* is queued (GET -> 202 -> poll /api/ops/result).
    // The terminal result is the apply dict; the image rides as base64 inside it
    // (no raw-binary channel). Legacy/dormant engines answer 200 synchronously
    // with the same payload shape — _requestQueued resolves both.
    //
    // Game capture over local HTTP structurally 409s today with a STRUCTURED
    // reason (`failure_reason:"unsupported_transport"`, `bridge_required:true`,
    // tool_net_thread.cpp:495-503). Detect that specific shape and return it
    // verbatim so the tool can give an honest message — do NOT hardcode "game
    // always fails": once the engine answers 200/202 (P4.4), the same response
    // flows into the normal queued path. ONE request either way: a probe that
    // discarded a 200 (or orphaned an accepted 202 requestId) and then asked
    // again would capture the game twice.
    let response: unknown;
    try {
      const res = await this._fetchRaw("GET", `/api/snapshot/${kind}`, undefined, 60_000);
      if (kind === "game" && res.status === 409) {
        return this._bridgeRequiredFromResponse(res);
      }
      response = await this._resolveQueuedResponse(res, undefined, 60_000);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    return this._parseSnapshotResponse(response, kind);
  }

  /** Shared: turn an ops/snapshot response envelope into an EngineSnapshot.
   *  Used by viewport/game snapshots and by scenePreview. */
  private async _parseSnapshotResponse(
    response: unknown,
    kind: "viewport" | "game" | "scene"
  ): Promise<EngineSnapshot> {
    const payload = findSnapshotPayload(response);
    if (!payload) {
      return {
        ok: false,
        error: "Snapshot response did not include an image payload.",
      };
    }

    const base64 = stringFrom(payload.base64) ?? stringFrom(payload.image_base64);
    if (!base64) {
      return {
        ok: false,
        error: stringFrom(payload.error) ?? "Snapshot response did not include image data.",
        failureReason: stringFrom(payload.failure_reason),
        sceneHasCamera: boolFrom(payload.scene_has_camera),
        sceneHadLight: boolFrom(payload.scene_had_light),
        usedSyntheticCamera: boolFrom(payload.used_synthetic_camera),
        metadata: withoutImageData(payload),
      };
    }

    const { format, mime, ext } = snapshotFormat(payload);
    const buffer = Buffer.from(base64, "base64");
    const localPath = await this.writeSnapshotFile(kind, buffer, ext);

    // Client-side identity drift check (item 4). Current engines validate the
    // identity query on snapshot reads, but older builds may ignore it. Re-read
    // health and compare to the bound hash so a frame from a switched project is
    // still marked as suspect. Best-effort: a failed health read never blocks the
    // already captured image.
    let projectMismatch: boolean | undefined;
    const boundProjectIdHash = this.targetIdentity.projectIdHash;
    if (boundProjectIdHash) {
      try {
        const health = await checkEngineHealth(this.port);
        if (health?.projectIdHash && health.projectIdHash !== boundProjectIdHash) {
          projectMismatch = true;
        }
      } catch {
        // ignore — never fail a capture on a transient health read
      }
    }

    return {
      ok: payload.ok !== false,
      localPath,
      path: localPath,
      base64,
      width: numberFrom(payload.width),
      height: numberFrom(payload.height),
      format,
      mime,
      context: stringFrom(payload.context),
      op: stringFrom(payload.op),
      provenance: payload.provenance,
      bytes: buffer.byteLength,
      sceneHasCamera: boolFrom(payload.scene_has_camera),
      sceneHadLight: boolFrom(payload.scene_had_light),
      usedSyntheticCamera: boolFrom(payload.used_synthetic_camera),
      framing: stringFrom(payload.framing),
      framedNode: stringFrom(payload.framed_node),
      renderRetries: numberFrom(payload.render_retries),
      projectMismatch,
      metadata: withoutImageData(payload),
    };
  }

  /**
   * Turn a 409 from /api/snapshot/game into a structured failure. The engine's
   * structural refusal carries `bridge_required` / `unsupported_transport`
   * (tool_net_thread.cpp:495-503); a 409 without that shape is surfaced as a
   * plain error rather than silently claiming "bridge required".
   */
  private async _bridgeRequiredFromResponse(res: Response): Promise<EngineSnapshot> {
    const body = (await res.json().catch(() => ({}))) as SnapshotPayload;
    const reason = stringFrom(body.failure_reason);
    const bridge = body.bridge_required === true;
    if (!bridge && reason !== "unsupported_transport") {
      // A 409 we don't recognize — surface it as a plain error rather than
      // silently claiming "bridge required".
      return {
        ok: false,
        error: stringFrom(body.error) ?? "Engine returned 409 for game snapshot.",
      };
    }
    return {
      ok: false,
      failureReason: reason ?? "bridge_required",
      error: stringFrom(body.error) ?? "Game snapshots require the desktop bridge async transport.",
    };
  }

  async viewportSnapshot(): Promise<EngineSnapshot> {
    return this.snapshot("viewport");
  }

  async gameSnapshot(): Promise<EngineSnapshot> {
    return this.snapshot("game");
  }

  /**
   * Offscreen scene render via the `ScenePreview` op over /api/ops (no game
   * boot; physics/animations are static). Mirrors the web previewScene op input
   * (snapshot-tools.ts): { op:'ScenePreview', scene_path?, framing?, size?,
   * node? } — scene_path optional, engine defaults to the open scene. `node` is
   * the canonical focus-node arg (the engine also accepts the legacy web wire
   * name `node_path`); an unresolvable node fails with failure_reason
   * "node_not_found". framing "auto" is an alias of "iso"; the engine also
   * accepts "top"/"front"/"back"/"left"/"right" and echoes the resolved framing.
   * framing "camera" renders through the scene's current/first Camera3D — or
   * the Camera3D named by `cameraPath` — with the scene's REAL WorldEnvironment
   * instead of the flat preview substitute; the engine echoes the resolved
   * framing, so an older build that ignores the value is detectable by the
   * caller. The result carries image_base64 + mime (+ width/height) plus the
   * P4.3 confession fields (scene_has_camera / scene_had_light /
   * used_synthetic_camera) and framing / framed_node / render_retries.
   *
   * Wave I (contracts "Perception additions"): framing "free" takes
   * `cameraPosition` / `cameraLookAt` (Godot "Vector3(x, y, z)" literals) and
   * `fov`; framing "bookmark:<name>" resolves the pose from the project's
   * camera bookmarks (fov overrides the bookmark's). `marks` draws the
   * Set-of-Mark overlay (numbered tags + boxes over the largest visible
   * VisualInstance3D nodes), capped by `maxMarks`. The result adds
   * framing_source / camera_pose / bookmark and marks / marks_skipped /
   * marks_candidates / marks_truncated / max_marks (all kept in `metadata`).
   * Older engines resolve the new framings to a preset and echo THAT — the
   * caller compares the echo against what it asked for.
   */
  async scenePreview(input?: {
    scenePath?: string;
    /** A preset ("auto" | "iso" | "top" | "front" | "back" | "left" | "right" |
     *  "camera"), "free", or "bookmark:<name>". */
    framing?: string;
    size?: [number, number];
    nodePath?: string;
    cameraPath?: string;
    cameraPosition?: string;
    cameraLookAt?: string;
    fov?: number;
    marks?: boolean;
    maxMarks?: number;
  }): Promise<EngineSnapshot> {
    const opInput: Record<string, unknown> = { op: "ScenePreview" };
    const trimmed = input?.scenePath?.trim();
    if (trimmed && trimmed !== "." && trimmed !== "./") opInput.scene_path = trimmed;
    if (input?.framing) opInput.framing = input.framing;
    if (input?.size) opInput.size = input.size;
    if (input?.nodePath) opInput.node = input.nodePath;
    if (input?.cameraPath) opInput.camera_path = input.cameraPath;
    if (input?.cameraPosition) opInput.camera_position = input.cameraPosition;
    if (input?.cameraLookAt) opInput.camera_look_at = input.cameraLookAt;
    if (input?.fov !== undefined) opInput.fov = input.fov;
    if (input?.marks !== undefined) opInput.marks = input.marks;
    if (input?.maxMarks !== undefined) opInput.max_marks = input.maxMarks;

    let response: unknown;
    try {
      // executeOps stamps the bound identity so a drifted project is rejected
      // (identity_mismatch) before rendering — ScenePreview reads no game state
      // but still targets a project's resources.
      response = await this.executeOps([opInput]);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return this._parseSnapshotResponse(response, "scene");
  }

  getPort(): number {
    return this.port;
  }

  /**
   * Cheap drift probe for the MCP client cache. The engine mints a fresh
   * api-token on every launch (local_api_server.cpp::_generate_api_token) and can
   * bind a different port (tool_net_thread.cpp::start increments 6550..6565 when
   * the old socket lingers), so a client built before an engine restart holds
   * dead credentials. Re-read the on-disk creds and report whether they no longer
   * match this client's snapshot.
   *
   * Empty / unreadable creds (engine mid-write, or just closed) are treated as
   * "no drift" so a transient read never thrashes the cache — the live request
   * will fail and trigger a reconnect+retry if the client really is stale.
   */
  async credentialsChanged(): Promise<boolean> {
    if (this.selection) {
      try {
        const connection = await resolveEngineConnection(this.selection);
        return (
          connection.port !== this.port ||
          connection.token !== this.token ||
          connection.health.instanceId !== this.targetIdentity.instanceId
        );
      } catch {
        // A selected editor disappearing is real drift. Dropping the cached
        // client makes the next connect report which project/instance is absent
        // instead of silently following another editor's global pointer.
        return true;
      }
    }

    try {
      const [port, token] = await Promise.all([getApiPort(), getApiToken()]);
      if (!token) return false;
      return port !== this.port || token !== this.token;
    } catch {
      return false;
    }
  }
}
