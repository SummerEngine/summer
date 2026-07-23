import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  getApiToken,
  getApiPort,
  checkEngineHealth,
  type EngineHealth,
} from "./engine.js";
import {
  classifyOpsResponse,
  pollOpToTerminal,
  type OpResultEnvelope,
} from "./async-op-lifecycle.js";

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
  terminalState?: string;
  errorClass?: string;
  requestId?: string;
  /** Scene-preview confession fields (P4.3). Populated only for target:"scene".
   *  A scene with no Camera3D renders grey/black when played; the engine reports
   *  whether it had to synthesize a camera/light so the model can warn honestly. */
  sceneHasCamera?: boolean;
  sceneHadLight?: boolean;
  usedSyntheticCamera?: boolean;
  /** Set true when the bound projectIdHash no longer matches the engine's live
   *  health hash at capture time — the frame may be from the WRONG project
   *  (item 4, client-side drift check). */
  projectMismatch?: boolean;
};

export type ProjectImportEntry = {
  url: string;
  path: string;
};

export type ProjectOpReceipt = {
  results?: Array<{
    ok?: boolean;
    op?: string;
    error?: string;
    meta?: unknown;
  }>;
};

export type ProjectFileReadState = {
  ok?: boolean;
  path?: string;
  content?: string;
  error?: string;
};

export type ProjectFileTreeState = {
  ok?: boolean;
  root?: string;
  exists?: boolean;
  files?: Array<{ path?: string }>;
  error?: string;
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
};

type EngineTargetIdentity = {
  instanceId?: string;
  projectId?: string;
  projectIdHash?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function boolFrom(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

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

export class EngineApiClient {
  private port: number;
  private token: string;
  // The engine and project this session is bound to. Every request carries the
  // identity captured from health so the engine can reject requests after an
  // in-place project switch or an unexpected instance change. The string form
  // preserves the pre-2.6.6 constructor contract for existing callers that only
  // supplied a projectIdHash.
  private targetIdentity: EngineTargetIdentity;

  constructor(
    port: number,
    token: string,
    targetIdentity: EngineTargetIdentity | string = {}
  ) {
    this.port = port;
    this.token = token;
    this.targetIdentity =
      typeof targetIdentity === "string"
        ? { projectIdHash: targetIdentity }
        : { ...targetIdentity };
  }

  static async connect(): Promise<EngineApiClient> {
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
    return new EngineApiClient(port, token, {
      instanceId: health.instanceId,
      projectId: health.projectId,
      projectIdHash: health.projectIdHash,
    });
  }

  /** The projectIdHash this session is bound to (undefined if none was reported
   *  at connect — e.g. no project open yet). */
  getBoundProjectIdHash(): string | undefined {
    return this.targetIdentity.projectIdHash;
  }

  /**
   * The only unscoped authenticated request this client may make. Health is the
   * deliberate discovery/rebind escape hatch after an in-place project switch;
   * every state read and mutation remains pinned to targetIdentity.
   */
  private async unscopedHealthRequest(): Promise<EngineHealth> {
    const res = await fetch(`http://127.0.0.1:${this.port}/api/health`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(2000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Engine API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const health = asRecord(await res.json());
    const engine = stringFrom(health?.engine);
    const version = stringFrom(health?.version);
    const instanceId = stringFrom(health?.instanceId);
    const projectId = stringFrom(health?.projectId);
    const projectIdHash = stringFrom(health?.projectIdHash);
    if (
      health?.ok !== true ||
      engine !== "summer" ||
      !version ||
      !instanceId ||
      !projectId ||
      !projectIdHash
    ) {
      throw new Error(
        "Summer Engine health did not include a complete project identity; refusing to rebind."
      );
    }

    return {
      ok: true,
      engine,
      version,
      port: numberFrom(health.port) ?? this.port,
      pid: numberFrom(health.pid),
      instanceId,
      projectId,
      projectIdHash,
      mainAliveMs: numberFrom(health.mainAliveMs),
      queueDepth: numberFrom(health.queueDepth),
      project_name: stringFrom(health.project_name),
      project_path: stringFrom(health.project_path),
      scene: stringFrom(health.scene),
    };
  }

  /**
   * Read unscoped health, validate the complete current identity, and rebind.
   * Called first by summer_get_project_context so a switched project can be
   * followed intentionally before any identity-scoped state read.
   */
  async rebindToCurrentProject(): Promise<EngineHealth> {
    const health = await this.unscopedHealthRequest();
    this.targetIdentity = {
      instanceId: health.instanceId,
      projectId: health.projectId,
      projectIdHash: health.projectIdHash,
    };
    return health;
  }

  /** Backward-compatible hash-only wrapper for existing internal callers. */
  async rebind(): Promise<string | undefined> {
    const health = await this.rebindToCurrentProject();
    return health.projectIdHash;
  }

  /** Identity to attach to a MUTATING command's options so the engine can reject
   *  a wrong-project write. Empty when unbound (engine then skips the check). */
  private identityOptions(): Record<string, unknown> {
    const projectIdHash = this.targetIdentity.projectIdHash;
    return projectIdHash ? { projectIdHash } : {};
  }

  private requireBoundMutationIdentity(): void {
    if (!this.targetIdentity.projectIdHash) {
      throw new Error(
        "Cannot mutate project files without a bound Summer Engine project identity."
      );
    }
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

    return res.json();
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

  private unknownOutcome(
    requestId: string,
    detail: string
  ): Record<string, unknown> {
    return {
      status: "error",
      terminalState: "unknown_outcome",
      errorClass: "ambiguous",
      requestId,
      error:
        `Engine operation ${requestId} timed out locally and its terminal outcome ` +
        `could not be confirmed (${detail}). It may still complete. Inspect the ` +
        "project state before retrying; do not retry automatically.",
    };
  }

  /**
   * After a local poll timeout, ask the native server to cancel the exact
   * request, then consume its one terminal receipt. A cancel response is only an
   * acknowledgement: canceled/applied is trustworthy only after result polling
   * confirms a terminal state.
   */
  private async _cancelTimedOutRequest(requestId: string): Promise<Record<string, unknown>> {
    let cancelResponse: Response;
    try {
      cancelResponse = await this._fetchRaw(
        "POST",
        `/api/ops/cancel?requestId=${encodeURIComponent(requestId)}`,
        undefined,
        10_000
      );
    } catch (err) {
      return this.unknownOutcome(
        requestId,
        `cancel transport failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const cancelBody = asRecord(await cancelResponse.json().catch(() => ({}))) ?? {};
    const cancelAccepted =
      cancelResponse.ok &&
      cancelBody.ok === true &&
      (cancelBody.canceled === true ||
        cancelBody.accepted === true ||
        cancelBody.preempted === true);

    // A rejected cancel can race with normal completion. Consume one immediate
    // result receipt before declaring the outcome unknown.
    if (!cancelAccepted) {
      try {
        const raced = await this._pollResult(requestId, 0);
        if (raced.status === "done" || raced.status === "failed" || raced.status === "canceled") {
          return pollOpToTerminal(async () => raced, {
            totalTimeoutMs: 1,
            requestId,
            sleep: async () => {},
          });
        }
      } catch {
        // The cancel response below remains the best available evidence.
      }

      const reason =
        stringFrom(cancelBody.error) ??
        stringFrom(cancelBody.errorClass) ??
        `cancel returned HTTP ${cancelResponse.status}`;
      return this.unknownOutcome(requestId, reason);
    }

    let terminal: Record<string, unknown>;
    try {
      terminal = await pollOpToTerminal(
        (waitMs) => this._pollResult(requestId, waitMs),
        {
          totalTimeoutMs: 15_000,
          noProgressTimeoutMs: 15_000,
          requestId,
        }
      );
    } catch (err) {
      return this.unknownOutcome(
        requestId,
        `terminal confirmation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (terminal.terminalState === "timed_out") {
      return this.unknownOutcome(requestId, "cancel was accepted but no terminal receipt arrived");
    }
    return terminal;
  }

  private async _resolveQueuedResponse(
    res: Response,
    timeoutMs: number
  ): Promise<unknown> {
    // 202 (queued) + 429 (backpressure, errorClass in body) are handled below;
    // any other non-2xx is a real transport error.
    if (!res.ok && res.status !== 202 && res.status !== 429) {
      const text = await res.text().catch(() => "");
      throw new Error(`Engine API error ${res.status}: ${text.slice(0, 200)}`);
    }
    const respBody = await res.json().catch(() => ({}));
    const classified = classifyOpsResponse(res.status, respBody);
    if (classified.mode === "legacy") {
      return respBody;
    }
    const terminal = await pollOpToTerminal(
      (waitMs) => this._pollResult(classified.requestId, waitMs),
      {
        totalTimeoutMs: timeoutMs,
        requestId: classified.requestId,
      }
    );
    if (terminal.terminalState === "timed_out") {
      return this._cancelTimedOutRequest(classified.requestId);
    }
    return terminal;
  }

  /**
   * Block E: send a mutating request, then resolve EITHER the legacy synchronous
   * result (HTTP 200 — dormant/older engine) OR the async lifecycle (202
   * {requestId} -> long-poll /api/ops/result until terminal). Compatible with
   * both — inspects the HTTP status, not a flag. `timeoutMs` is the poll loop's
   * total budget; a long op that keeps advancing is not falsely timed out.
   */
  private async _requestQueued(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    const res = await this._fetchRaw(method, path, body, timeoutMs);
    return this._resolveQueuedResponse(res, timeoutMs);
  }

  async health(): Promise<unknown> {
    return this.request("GET", "/api/health");
  }

  async executeOps(
    ops: Record<string, unknown>[],
    options?: Record<string, unknown>
  ): Promise<unknown> {
    // Ops may include long-running work (ImportFromUrlBatch, GitCommit); the
    // engine keeps it "running" and we poll. 120s budget. Resolves legacy-200 or
    // async-202 (Block E).
    // Attach the bound project identity so the engine rejects a write aimed at a
    // different project (identity_mismatch, atomic — before any op applies).
    const merged = { ...this.identityOptions(), ...(options ?? {}) };
    const body = Object.keys(merged).length ? { ops, options: merged } : { ops };
    return this._requestQueued("POST", "/api/ops", body, 120_000);
  }

  async getSceneState(): Promise<unknown> {
    return this.request("GET", "/api/state/scene");
  }

  async getProjectState(): Promise<unknown> {
    return this.request("GET", "/api/state/project");
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

  async play(scene?: string): Promise<unknown> {
    // Cold-load on large projects can take 25-40s. 60s budget.
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

  async readProjectTextFile(
    path: string,
    maxBytes = 1024 * 1024
  ): Promise<ProjectFileReadState> {
    return (await this.readFile(path, maxBytes)) as ProjectFileReadState;
  }

  async listProjectFiles(
    root: string,
    limit = 2000
  ): Promise<ProjectFileTreeState> {
    return (await this.getFsTree(root, limit)) as ProjectFileTreeState;
  }

  async importProjectFiles(
    imports: ProjectImportEntry[]
  ): Promise<ProjectOpReceipt> {
    this.requireBoundMutationIdentity();
    return (await this.executeOps([
      { op: "ImportFromUrlBatch", imports },
    ])) as ProjectOpReceipt;
  }

  async renameProjectFile(from: string, to: string): Promise<ProjectOpReceipt> {
    this.requireBoundMutationIdentity();
    return (await this.executeOps([
      { op: "RenameFile", from, to },
    ])) as ProjectOpReceipt;
  }

  async deleteProjectFile(path: string): Promise<ProjectOpReceipt> {
    this.requireBoundMutationIdentity();
    return (await this.executeOps([
      { op: "DeleteFile", path },
    ])) as ProjectOpReceipt;
  }

  async writeProjectTextFile(
    path: string,
    content: string
  ): Promise<ProjectOpReceipt> {
    this.requireBoundMutationIdentity();
    return (await this.executeOps([
      { op: "WriteFile", path, content },
    ])) as ProjectOpReceipt;
  }

  async instantiateProjectScene(
    parent: string,
    scene: string,
    name: string
  ): Promise<ProjectOpReceipt> {
    this.requireBoundMutationIdentity();
    return (await this.executeOps([
      { op: "InstantiateScene", parent, scene, name },
    ])) as ProjectOpReceipt;
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
    // always fails": once the engine answers 200/202 (P4.4), the normal path
    // below just works.
    let response: unknown;
    try {
      // Exactly one snapshot request. Its response decides the legacy, queued,
      // or recognized bridge-required path; never probe and then enqueue again.
      const res = await this._fetchRaw(
        "GET",
        `/api/snapshot/${kind}`,
        undefined,
        60_000
      );
      if (kind === "game" && res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as SnapshotPayload;
        const reason = stringFrom(body.failure_reason);
        const bridge = body.bridge_required === true;
        if (bridge || reason === "unsupported_transport") {
          return {
            ok: false,
            failureReason: reason ?? "bridge_required",
            error:
              stringFrom(body.error) ??
              "Game snapshots require the desktop bridge async transport.",
          };
        }
        throw new Error(
          stringFrom(body.error) ?? "Engine returned an unrecognized 409 for game snapshot."
        );
      }
      response = await this._resolveQueuedResponse(res, 60_000);
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
      const envelope = asRecord(response);
      return {
        ok: false,
        error:
          stringFrom(envelope?.error) ??
          "Snapshot response did not include an image payload.",
        terminalState: stringFrom(envelope?.terminalState),
        errorClass: stringFrom(envelope?.errorClass),
        requestId: stringFrom(envelope?.requestId),
        metadata: envelope ?? undefined,
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
      projectMismatch,
      metadata: withoutImageData(payload),
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
   * node_path? } — scene_path optional, engine defaults to the open scene. The
   * result carries image_base64 + mime (+ width/height) plus the P4.3 confession
   * fields (scene_has_camera / scene_had_light / used_synthetic_camera).
   */
  async scenePreview(input?: {
    scenePath?: string;
    framing?: "auto" | "top" | "front" | "iso";
    size?: [number, number];
    nodePath?: string;
  }): Promise<EngineSnapshot> {
    const opInput: Record<string, unknown> = { op: "ScenePreview" };
    const trimmed = input?.scenePath?.trim();
    if (trimmed && trimmed !== "." && trimmed !== "./") opInput.scene_path = trimmed;
    if (input?.framing) opInput.framing = input.framing;
    if (input?.size) opInput.size = input.size;
    if (input?.nodePath) opInput.node_path = input.nodePath;

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
    try {
      const [port, token] = await Promise.all([getApiPort(), getApiToken()]);
      if (!token) return false;
      return port !== this.port || token !== this.token;
    } catch {
      return false;
    }
  }
}
