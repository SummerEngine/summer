import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getApiToken, getApiPort, checkEngineHealth } from "./engine.js";
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
};

type SnapshotPayload = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  base64?: string;
  image_base64?: string;
  width?: number;
  height?: number;
  format?: string;
  mime?: string;
  context?: string;
  op?: string;
  provenance?: unknown;
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

function findSnapshotPayload(value: unknown): SnapshotPayload | null {
  const record = asRecord(value);
  if (!record) return null;

  if (
    typeof record.base64 === "string" ||
    typeof record.image_base64 === "string" ||
    record.op === "ViewportSnapshot" ||
    record.op === "GameSnapshot"
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
  // The project this session is BOUND to — the projectIdHash reported by the
  // engine when this client first connected. Sent on every mutating op so the
  // engine's identity guard (local_api_server.cpp ~271-302) atomically rejects a
  // write aimed at a DIFFERENT project (e.g. after the user switched projects
  // in-place). Health is the only identity signal the MCP has — /api/state/project
  // carries no path and /api/health exposes only projectIdHash, not the raw id.
  private boundProjectIdHash?: string;

  constructor(port: number, token: string, boundProjectIdHash?: string) {
    this.port = port;
    this.token = token;
    this.boundProjectIdHash = boundProjectIdHash;
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
    return new EngineApiClient(port, token, health.projectIdHash);
  }

  /** The projectIdHash this session is bound to (undefined if none was reported
   *  at connect — e.g. no project open yet). */
  getBoundProjectIdHash(): string | undefined {
    return this.boundProjectIdHash;
  }

  /**
   * Re-read health and rebind to the currently-open project. Called by
   * summer_get_project_context so the agent can INTENTIONALLY follow a project
   * switch (the deliberate escape hatch after an identity_mismatch). Returns the
   * new bound hash. Reads carry no identity, so this always reaches the engine
   * even when a mutation would be rejected.
   */
  async rebind(): Promise<string | undefined> {
    const health = await checkEngineHealth(this.port);
    if (health) {
      this.boundProjectIdHash = health.projectIdHash;
    }
    return this.boundProjectIdHash;
  }

  /** Identity to attach to a MUTATING command's options so the engine can reject
   *  a wrong-project write. Empty when unbound (engine then skips the check). */
  private identityOptions(): Record<string, unknown> {
    return this.boundProjectIdHash ? { projectIdHash: this.boundProjectIdHash } : {};
  }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const url = `http://127.0.0.1:${this.port}${path}`;
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
    return fetch(`http://127.0.0.1:${this.port}${path}`, {
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
   * total budget; a long op that keeps advancing is not falsely timed out.
   */
  private async _requestQueued(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number
  ): Promise<unknown> {
    const res = await this._fetchRaw(method, path, body, timeoutMs);
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
    return pollOpToTerminal((waitMs) => this._pollResult(classified.requestId, waitMs), {
      totalTimeoutMs: timeoutMs,
    });
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

  async getSelection(): Promise<unknown> {
    return this.request("GET", "/api/state/selection");
  }

  private async writeSnapshotFile(
    kind: "viewport" | "game",
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
    let response: unknown;
    try {
      response = await this._requestQueued("GET", `/api/snapshot/${kind}`, undefined, 60_000);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const payload = findSnapshotPayload(response);
    if (!payload) {
      return {
        ok: false,
        error: "Snapshot response did not include a viewport/game payload.",
      };
    }

    const base64 = stringFrom(payload.base64) ?? stringFrom(payload.image_base64);
    if (!base64) {
      return {
        ok: false,
        error: stringFrom(payload.error) ?? "Snapshot response did not include image data.",
        metadata: withoutImageData(payload),
      };
    }

    const { format, mime, ext } = snapshotFormat(payload);
    const buffer = Buffer.from(base64, "base64");
    const localPath = await this.writeSnapshotFile(kind, buffer, ext);

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
      metadata: withoutImageData(payload),
    };
  }

  async viewportSnapshot(): Promise<EngineSnapshot> {
    return this.snapshot("viewport");
  }

  async gameSnapshot(): Promise<EngineSnapshot> {
    return this.snapshot("game");
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
