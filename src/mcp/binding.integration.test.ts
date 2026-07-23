import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Project-binding proof over REAL HTTP.
 *
 * A fake engine emulates the identity preflight (local_api_server.cpp ~271-302):
 * a command carrying options.projectIdHash that differs from the engine's current
 * project is rejected with terminalState "identity_mismatch" BEFORE anything is
 * applied; an empty/absent hash skips the check. Reads validate the same query
 * identity, while GET /api/health is the one deliberate unscoped rebind path.
 *
 * Proves: the MCP client binds to the open project on connect, sends that hash on
 * mutations (so a write aimed at a switched-to project is atomically rejected),
 * keeps ordinary reads scoped, and rebinds through unscoped health on demand.
 *
 * Only the credential-file readers are stubbed, so nothing touches ~/.summer.
 */

const engine = {
  token: "tok",
  port: 0,
  projectIdHash: "hash-A",
  lastOpsBody: null as unknown,
  lastReadHadIdentity: false,
  lastHealthHadIdentity: false,
};

vi.mock("../lib/engine.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/engine.js")>();
  return {
    ...actual,
    getApiPort: vi.fn(async () => engine.port),
    getApiToken: vi.fn(async () => engine.token),
  };
});

import { getClient, resetClient } from "./server.js";
import { withEngine } from "./tools/with-engine.js";

let server: Server;

function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";

    if (url.startsWith("/api/health")) {
      const parsed = new URL(url, `http://127.0.0.1:${engine.port}`);
      engine.lastHealthHadIdentity =
        parsed.searchParams.has("instanceId") ||
        parsed.searchParams.has("projectId") ||
        parsed.searchParams.has("projectIdHash");
      send(200, {
        ok: true,
        engine: "summer",
        version: "0.5.42",
        port: engine.port,
        instanceId: "inst",
        projectId: `project-${engine.projectIdHash}`,
        projectIdHash: engine.projectIdHash,
      });
      return;
    }

    if (url.startsWith("/api/ops")) {
      const body = await readJson(req);
      engine.lastOpsBody = body;
      const opts = (body.options ?? {}) as Record<string, unknown>;
      const want = typeof opts.projectIdHash === "string" ? opts.projectIdHash : "";
      // Identity preflight — reject BEFORE apply when a non-empty hash mismatches.
      if (want && want !== engine.projectIdHash) {
        send(200, {
          ok: false,
          status: "error",
          terminalState: "identity_mismatch",
          errorClass: "rejected_identity",
          error: "projectIdHash mismatch",
        });
        return;
      }
      send(200, { status: "ok", terminalState: "applied", results: [{ ok: true, op: "Probe" }] });
      return;
    }

    if (url.startsWith("/api/state/")) {
      const parsed = new URL(url, `http://127.0.0.1:${engine.port}`);
      const want = parsed.searchParams.get("projectIdHash") ?? "";
      engine.lastReadHadIdentity = want.length > 0;
      if (want && want !== engine.projectIdHash) {
        send(409, {
          ok: false,
          status: "error",
          terminalState: "identity_mismatch",
          errorClass: "rejected_identity",
          error: "projectIdHash mismatch",
        });
        return;
      }
      send(200, { ok: true, data: { entries: [] } });
      return;
    }

    send(404, { ok: false, error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  engine.port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());
afterEach(() => resetClient());

describe("MCP project binding — engine-enforced, atomic", () => {
  it("binds to the open project on connect and stamps its hash on mutations", async () => {
    engine.projectIdHash = "hash-A";
    const client = await getClient();
    expect(client.getBoundProjectIdHash()).toBe("hash-A");

    const res = (await client.executeOps([{ op: "Probe" }])) as Record<string, unknown>;
    expect(res.terminalState).toBe("applied");
    // The mutation body carried the bound identity.
    const body = engine.lastOpsBody as { options?: { projectIdHash?: string } };
    expect(body.options?.projectIdHash).toBe("hash-A");
  });

  it("is atomically REJECTED when the engine switched to a different project", async () => {
    engine.projectIdHash = "hash-A";
    const client = await getClient(); // bound to A
    expect(client.getBoundProjectIdHash()).toBe("hash-A");

    // User switches project in the engine: A -> B. Same token, so the cached
    // client keeps its binding to A.
    engine.projectIdHash = "hash-B";

    const res = (await client.executeOps([{ op: "Probe" }])) as Record<string, unknown>;
    expect(res.terminalState).toBe("identity_mismatch"); // never applied to B
  });

  it("rebinds through unscoped health before scoped reads after a switch", async () => {
    engine.projectIdHash = "hash-A";
    const client = await getClient();
    engine.projectIdHash = "hash-B"; // switch

    await expect(client.getSceneState()).rejects.toThrow(/409/);

    // The exact first step summer_get_project_context performs follows the
    // switch without carrying the stale A identity.
    const health = await client.rebindToCurrentProject();
    expect(health.projectIdHash).toBe("hash-B");
    expect(engine.lastHealthHadIdentity).toBe(false);

    const scene = (await client.getSceneState()) as Record<string, unknown>;
    expect(scene.ok).toBe(true);
    expect(engine.lastReadHadIdentity).toBe(true);

    // Now mutations target B and apply.
    const res = (await client.executeOps([{ op: "Probe" }])) as Record<string, unknown>;
    expect(res.terminalState).toBe("applied");
    const body = engine.lastOpsBody as { options?: { projectIdHash?: string } };
    expect(body.options?.projectIdHash).toBe("hash-B");
  });

  it("surfaces an actionable rebind hint to the agent via withEngine on a switch", async () => {
    engine.projectIdHash = "hash-A";
    await getClient(); // bind to A
    engine.projectIdHash = "hash-B"; // switch

    const res = await withEngine(async (client) => client.executeOps([{ op: "Probe" }]));
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text?: string }).text ?? "";
    expect(text.toLowerCase()).toContain("different project");
    expect(text).toContain("summer_get_project_context");
  });

  it("sends NO identity when unbound (no project hash) so the engine skips the check", async () => {
    engine.projectIdHash = ""; // engine reports no project hash
    const client = await getClient();
    expect(client.getBoundProjectIdHash()).toBeFalsy();

    const res = (await client.executeOps([{ op: "Probe" }])) as Record<string, unknown>;
    expect(res.terminalState).toBe("applied");
    const body = engine.lastOpsBody as { ops?: unknown; options?: unknown };
    // Backward-compatible body shape: no options injected.
    expect(body.options).toBeUndefined();
  });
});
