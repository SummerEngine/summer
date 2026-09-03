import type { EngineSnapshot } from "../api-client.js";
import type { WorkerConnection } from "./worker-connection.js";
import {
  parseEngineCapabilities,
  type EngineCapabilities,
} from "../capability-skew.js";
import { UnsupportedOperationError } from "../tool-errors.js";

/**
 * EngineApiClient-shaped facade over a WorkerConnection, so the existing MCP
 * tool handlers (which all call typed methods on the client withEngine hands
 * them) can be served by a headless worker WITHOUT any tool-file changes.
 *
 * Implements the FULL public method surface of EngineApiClient:
 *   - methods with a worker equivalent delegate to the worker op
 *   - methods without one throw a clean, actionable error, which withEngine
 *     surfaces verbatim as an isError tool result — nothing is silently faked
 *
 * The MCP wiring (mcp-routing.ts) returns this cast to EngineApiClient; the
 * cast is sound because every public method exists here. Only reachable when
 * SUMMER_HEADLESS_ROUTING=1 and no live editor has the project open.
 */

/** Tagged so withEngine classifies it "unsupported" (nothing sent, keep the
 *  client, no transport recovery recipe) instead of "transport". */
function unsupported(method: string): never {
  throw new UnsupportedOperationError(
    `"${method}" is not supported by the headless worker serving this project. ` +
      "Only file, import, scene-read, and game run/stop/log/screenshot operations work headless. " +
      "Open the project in the Summer editor (npx -y summer-engine@latest run <path>) for full coverage."
  );
}

type JsonRecord = Record<string, unknown>;

/** Worker ops take project-relative paths; the editor tool surface speaks
 *  res:// URIs. Strip the scheme before anything crosses the wire (the
 *  worker is also adding acceptance — both sides tolerate both forms). */
function stripRes(path: string): string {
  return path.startsWith("res://") ? path.slice("res://".length) : path;
}

export class WorkerEngineClient {
  private connection: WorkerConnection;
  /** Last `status` answer, for the capability/version getters withEngine's
   *  pre-flight (missingEngineOpResult) and skew warning read synchronously. */
  private lastStatus: JsonRecord | undefined;

  constructor(connection: WorkerConnection) {
    this.connection = connection;
  }

  get projectPath(): string {
    return this.connection.projectPath;
  }

  isAlive(): boolean {
    return this.connection.isAlive();
  }

  close(): void {
    this.connection.close();
  }

  // ---- supported surface -------------------------------------------------

  async health(): Promise<unknown> {
    const status = await this.connection.call("status");
    this.lastStatus =
      status && typeof status === "object" && !Array.isArray(status)
        ? (status as JsonRecord)
        : undefined;
    return status;
  }

  /** The worker's capability advert from the last `status` read (health()),
   *  or undefined before the first read / when the worker advertises none.
   *  Same contract as EngineApiClient.getEngineCapabilities: an absent
   *  advert proves nothing, so the pre-flight lets the call through. */
  getEngineCapabilities(): EngineCapabilities | undefined {
    return parseEngineCapabilities(this.lastStatus?.capabilities);
  }

  /** Engine version string from the last `status` read, for skew messages. */
  getEngineVersion(): string | undefined {
    const version = this.lastStatus?.version;
    return typeof version === "string" && version.length > 0 ? version : undefined;
  }

  async readFile(path: string, maxBytes?: number): Promise<unknown> {
    // Worker supports maxBytes up to 8MiB — clamp client-side.
    const clamped =
      maxBytes !== undefined
        ? Math.min(maxBytes, 8 * 1024 * 1024)
        : undefined;
    return this.connection.call("fs.read", {
      path: stripRes(path),
      ...(clamped !== undefined ? { maxBytes: clamped } : {}),
    });
  }

  async readProjectFile(path: string, maxBytes = 200_000): Promise<unknown> {
    return this.readFile(path, maxBytes);
  }

  async getFsTree(root = "res://", _limit = 2000): Promise<unknown> {
    // Worker contract: fs.list takes {dir}, project-relative — the default
    // res:// root maps to "" (project root). `limit` is not implemented
    // worker-side — dropped (results are project-file listings, bounded in
    // practice by the project itself).
    return this.connection.call("fs.list", { dir: stripRes(root) });
  }

  async getSceneState(
    scenePath?: string,
    _options?: { depth?: number; limit?: number }
  ): Promise<unknown> {
    // Worker contract: scene.read takes {path}. depth/limit are not part of
    // the worker contract — dropped (the editor path still honors them).
    return this.connection.call("scene.read", {
      ...(scenePath ? { path: stripRes(scenePath) } : {}),
    });
  }

  async play(scene?: string): Promise<unknown> {
    return this.connection.call(
      "game.run",
      scene ? { scene: stripRes(scene) } : {}
    );
  }

  async stop(): Promise<unknown> {
    return this.connection.call("game.stop", {}, { timeoutMs: 15_000 });
  }

  async gameSnapshot(): Promise<EngineSnapshot> {
    try {
      const result = (await this.connection.call("game.screenshot")) as
        | JsonRecord
        | undefined;
      const base64 =
        typeof result?.base64 === "string"
          ? result.base64
          : typeof result?.image_base64 === "string"
            ? result.image_base64
            : undefined;
      return { ok: true, ...(result ?? {}), base64 } as EngineSnapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: message.includes("needs_display")
          ? "The headless worker has no display to capture. Open the project in the Summer editor to take game screenshots."
          : message,
        ...(message.includes("needs_display")
          ? { failureReason: "needs_display" }
          : {}),
      };
    }
  }

  /**
   * The worker exposes a fixed op set, not the editor's generic ops queue.
   * Batches made ONLY of ops with worker equivalents are translated
   * (WriteFile -> fs.write, GetConsoleOutput -> game.logs {tail},
   * IsGameRunning -> game.logs reading result.running); anything else fails
   * loudly BEFORE any op in the batch is applied.
   */
  async executeOps(
    ops: JsonRecord[],
    _options?: JsonRecord
  ): Promise<unknown> {
    const supported = new Set(["WriteFile", "GetConsoleOutput", "IsGameRunning"]);
    const rejected = ops.find((op) => !supported.has(String(op.op)));
    if (rejected) {
      unsupported(`executeOps op "${String(rejected.op)}"`);
    }
    const results: JsonRecord[] = [];
    for (const op of ops) {
      const name = String(op.op);
      if (name === "WriteFile") {
        const result = await this.connection.call("fs.write", {
          path: stripRes(String(op.path ?? "")),
          content: op.content,
          ...(op.expectedSha256 !== undefined
            ? { expectedSha256: op.expectedSha256 }
            : {}),
          ...(op.mustNotExist === true ? { mustNotExist: true } : {}),
        });
        results.push({ ok: true, op: name, ...(result as JsonRecord | undefined) });
      } else if (name === "GetConsoleOutput") {
        // Worker contract: game.logs takes {tail}; filter/type are not
        // supported worker-side. `filter` is applied client-side on the
        // returned lines; `type` is dropped (documented in
        // docs/HEADLESS_ROUTING.md).
        const result = (await this.connection.call("game.logs", {
          ...(op.max_lines !== undefined ? { tail: op.max_lines } : {}),
        })) as JsonRecord | undefined;
        let shaped: JsonRecord | undefined = result;
        const filter = typeof op.filter === "string" ? op.filter : null;
        if (filter && result && Array.isArray(result.lines)) {
          shaped = {
            ...result,
            lines: (result.lines as unknown[]).filter(
              (line) => typeof line === "string" && line.includes(filter)
            ),
          };
        }
        results.push({ ok: true, op: name, ...(shaped ?? {}) });
      } else {
        // IsGameRunning: the worker's status op has NO running field — the
        // authoritative flag rides on game.logs as result.running. Before
        // the first game.run, older workers ERROR on game.logs while newer
        // ones answer {running:false}; both mean "not running" and must
        // never throw. Transport failures (dead connection) still propagate.
        let running = false;
        try {
          const result = (await this.connection.call("game.logs", {
            tail: 0,
          })) as JsonRecord | undefined;
          running = result?.running === true;
        } catch (error) {
          const isWorkerAnswer =
            error instanceof Error && error.name === "WorkerOpError";
          if (!isWorkerAnswer) throw error;
          // The worker answered with an error — no game session exists.
          running = false;
        }
        results.push({ ok: true, op: name, running });
      }
    }
    return { ok: true, results };
  }

  async executeIdentityBoundOps(
    ops: JsonRecord[],
    options?: JsonRecord
  ): Promise<unknown> {
    // A worker serves exactly one project by construction — the identity
    // binding the editor needs (project switches under one HTTP port) has no
    // headless analogue.
    return this.executeOps(ops, options);
  }

  // ---- identity / cache plumbing getClient() relies on --------------------

  getBoundProjectIdHash(): string | undefined {
    return undefined;
  }

  async rebind(): Promise<string | undefined> {
    return undefined;
  }

  getPort(): number {
    return -1;
  }

  async credentialsChanged(): Promise<boolean> {
    // A dropped worker socket = stale client; getClient's cache check drops
    // it and the next call re-resolves (editor-beats-worker-beats-spawn).
    return !this.connection.isAlive();
  }

  // ---- editor-only surface (fails loudly, never fakes) --------------------

  async getProjectState(_prefix?: string): Promise<unknown> {
    unsupported("getProjectState");
  }
  async getDiagnostics(): Promise<unknown> {
    unsupported("getDiagnostics");
  }
  async inspectNode(_path: string): Promise<unknown> {
    unsupported("inspectNode");
  }
  async inspectResource(_path: string): Promise<unknown> {
    unsupported("inspectResource");
  }
  async getScriptErrors(_path: string): Promise<unknown> {
    unsupported("getScriptErrors");
  }
  async getSelection(): Promise<unknown> {
    unsupported("getSelection");
  }
  async viewportSnapshot(): Promise<EngineSnapshot> {
    unsupported("viewportSnapshot");
  }
  async scenePreview(_input?: unknown): Promise<EngineSnapshot> {
    unsupported("scenePreview");
  }
  /** The worker has no events channel (no /api/events); the events tools'
   *  pre-flight already refuses on a status without capabilities.events, so
   *  this is reached only with SUMMER_CAPABILITY_PREFLIGHT=off. */
  async pollEvents(_params?: unknown, _timeoutMs?: number): Promise<unknown> {
    unsupported("pollEvents");
  }
}
