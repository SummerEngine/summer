import type { EngineApiClient } from "../api-client.js";
import type { CallOptions, ProjectConnection } from "./connection.js";

/**
 * Adapter that presents the EXISTING editor transport (EngineApiClient over
 * local HTTP — untouched) through the uniform ProjectConnection surface.
 *
 * The canonical `call()` vocabulary is the WORKER op set; this adapter maps
 * each worker op onto the editor method that answers the same question. Ops
 * with no editor equivalent throw a clean, actionable error — they are never
 * silently faked.
 *
 * The raw client stays reachable via `client` so callers that need the full
 * editor surface (all ~22 EngineApiClient methods, identity binding, the
 * async op lifecycle) can keep using it directly. The MCP flag-wiring does
 * exactly that: when resolution picks the editor, the existing code path is
 * used unchanged and this adapter is not even in the loop.
 */
export class EditorConnection implements ProjectConnection {
  readonly kind = "editor" as const;
  readonly projectPath: string;
  readonly client: EngineApiClient;

  constructor(client: EngineApiClient, projectPath: string) {
    this.client = client;
    this.projectPath = projectPath;
  }

  isAlive(): boolean {
    // The HTTP transport is connectionless; liveness is checked per-request
    // by the existing credential-drift logic in the client/getClient layer.
    return true;
  }

  close(): void {
    // Nothing to tear down — the HTTP client holds no socket.
  }

  async call(
    op: string,
    params: Record<string, unknown> = {},
    _options: CallOptions = {}
  ): Promise<unknown> {
    switch (op) {
      case "ping":
      case "status":
        return this.client.health();
      case "import":
        // The editor imports continuously via its filesystem scanner; there is
        // nothing to trigger. Honest no-op with provenance.
        return { ok: true, mode: "editor", note: "The editor imports assets continuously; no explicit import step exists on this transport." };
      case "fs.list":
        return this.client.getFsTree(
          typeof params.root === "string" ? params.root : undefined,
          typeof params.limit === "number" ? params.limit : undefined
        );
      case "fs.read":
        return this.client.readFile(
          String(params.path ?? ""),
          typeof params.maxBytes === "number" ? params.maxBytes : undefined
        );
      case "fs.write":
        return this.client.executeIdentityBoundOps([
          {
            op: "WriteFile",
            path: String(params.path ?? ""),
            content: String(params.content ?? ""),
            ...(typeof params.expectedSha256 === "string"
              ? { expectedSha256: params.expectedSha256 }
              : {}),
            ...(params.mustNotExist === true ? { mustNotExist: true } : {}),
          },
        ]);
      case "scene.read":
        return this.client.getSceneState(
          typeof params.scenePath === "string" ? params.scenePath : undefined,
          {
            depth: typeof params.depth === "number" ? params.depth : undefined,
            limit: typeof params.limit === "number" ? params.limit : undefined,
          }
        );
      case "game.run":
        return this.client.play(
          typeof params.scene === "string" ? params.scene : undefined
        );
      case "game.stop":
        return this.client.stop();
      case "game.logs": {
        const opInput: Record<string, unknown> = { op: "GetConsoleOutput" };
        if (typeof params.maxLines === "number") opInput.max_lines = params.maxLines;
        if (typeof params.filter === "string") opInput.filter = params.filter;
        return this.client.executeOps([opInput]);
      }
      case "game.screenshot":
        return this.client.gameSnapshot();
      case "uid.resolve":
      default:
        throw new Error(
          `Op "${op}" has no editor-transport mapping. Use the EngineApiClient directly (EditorConnection.client) or route to a headless worker.`
        );
    }
  }
}
