import { getApiToken, getApiPort, checkEngineHealth } from "./engine.js";

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

  async getFsTree(root?: string, limit?: number): Promise<unknown> {
    const params = new URLSearchParams();
    if (root) params.set("root", root);
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return this.request("GET", `/api/state/fs-tree${qs ? `?${qs}` : ""}`);
  }

  async play(scene?: string): Promise<unknown> {
    return this.request("POST", "/api/play", scene ? { scene } : {});
  }

  async stop(): Promise<unknown> {
    return this.request("POST", "/api/stop");
  }

  async viewportSnapshot(): Promise<unknown> {
    return this.request("GET", "/api/snapshot/viewport");
  }

  async gameSnapshot(): Promise<unknown> {
    return this.request("GET", "/api/snapshot/game");
  }
}
