import { mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getApiToken, getApiPort, checkEngineHealth } from "./engine.js";

export type EngineSnapshot = {
  ok: boolean;
  localPath?: string;
  path?: string;
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

  constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
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

    return new EngineApiClient(port, token);
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

  async health(): Promise<unknown> {
    return this.request("GET", "/api/health");
  }

  async executeOps(
    ops: Record<string, unknown>[],
    options?: Record<string, unknown>
  ): Promise<unknown> {
    return this.request("POST", "/api/ops", { ops, options });
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
    return this.request("POST", "/api/play", scene ? { scene } : {});
  }

  async stop(): Promise<unknown> {
    return this.request("POST", "/api/stop");
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
    const url = `http://127.0.0.1:${this.port}/api/snapshot/${kind}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Snapshot failed ${res.status}: ${text.slice(0, 200)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      const { format, mime, ext } = snapshotFormat({ mime: contentType });
      const buffer = Buffer.from(await res.arrayBuffer());
      const localPath = await this.writeSnapshotFile(kind, buffer, ext);

      return {
        ok: true,
        localPath,
        path: localPath,
        format,
        mime,
        context: kind === "viewport" ? "scene" : "game",
        bytes: buffer.byteLength,
      };
    }

    const response = await res.json();
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
}
