import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportGame, readLastExport } from "./export-game.js";
import { EngineApiClient } from "../api-client.js";
import { publishBuild } from "./publish-build.js";
import { writeZip } from "../util/zip-write.js";
import { setSummerDirForTests } from "../store.js";
import type { WebOnlyClient } from "./export-web-only.js";

let root: string;
let project: string;
let bytes: Buffer;
let sha256: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-web-only-export-"));
  project = join(root, "game");
  await mkdir(join(project, ".summer"), { recursive: true });
  await writeFile(join(project, "project.godot"), "config_version=5\n");
  await writeFile(join(project, ".summer/project.json"), JSON.stringify({ kind: "web-only" }));
  const html = join(root, "index.html");
  await writeFile(html, "<html>game</html>");
  const fixture = join(root, "fixture.zip");
  await writeZip(fixture, [{ name: "index.html", source: html }]);
  bytes = await readFile(fixture);
  sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  setSummerDirForTests(join(root, "store"));
});
afterEach(async () => { setSummerDirForTests(null); await rm(root, { recursive: true, force: true }); });

function client(behavior: "success" | "failed" | "digest" | "wrong-path" = "success") {
  let id = "";
  const executeIdentityBoundOps = vi.fn(async (ops: Record<string, unknown>[]) => {
    const op = ops[0]!;
    if (op.op === "ExportGameBuild") {
      id = String(op.jobId);
      return { ok: true, results: [{ ok: true, data: { schema: "summer.game-build.v1", jobId: id, state: "queued" } }] };
    }
    expect(op).toEqual({ op: "GameBuildStatus", jobId: id });
    if (behavior === "failed") return { ok: true, results: [{ ok: true, data: { schema: "summer.game-build.v1", jobId: id, state: "failed", error: "compile failed" } }] };
    const relativePath = `.summer/export-jobs/game-${id}/game.zip`;
    await mkdir(join(project, `.summer/export-jobs/game-${id}`), { recursive: true });
    await writeFile(join(project, relativePath), bytes);
    return { ok: true, results: [{ ok: true, data: { schema: "summer.game-build.v1", jobId: id, state: "ready", artifact: { format: "web-zip", entryPoint: "index.html", targetPlatforms: ["web"], relativePath: behavior === "wrong-path" ? ".summer/cache/stale.zip" : relativePath, sha256: behavior === "digest" ? `sha256:${"0".repeat(64)}` : sha256, sizeBytes: bytes.length } } }] };
  });
  return { executeIdentityBoundOps, getEngineCapabilities: () => ({ gameBuildFormats: ["web-zip"] }) } satisfies WebOnlyClient;
}

describe("web-only export", () => {
  it("dispatches a fresh identity-bound native job and records its immutable web download", async () => {
    const engine = client();
    const connect = vi.fn(async (selected: string) => { expect(selected).toBe(project); return engine; });
    const findBinary = vi.fn(() => { throw new Error("must not launch a headless exporter"); });
    const result = await exportGame({ project }, { webOnlyConnect: connect, findBinary });
    expect(result).toMatchObject({ format: "download", targets: ["web"], storePlatform: "web", sha256, sizeBytes: bytes.length });
    expect(await readFile(result.path)).toEqual(bytes);
    expect(engine.executeIdentityBoundOps.mock.calls[0]![0][0]).toEqual({ op: "ExportGameBuild", jobId: expect.any(String) });
    expect(findBinary).not.toHaveBeenCalled();
    expect(await readLastExport()).toMatchObject({ path: result.path, project, sha256, storePlatform: "web" });
  });
  it("uses the real identity-bound engine client for start and status", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fake = client();
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(input), body });
      const value = await fake.executeIdentityBoundOps(body.ops);
      return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", transport);
    try {
      const native = new EngineApiClient(12345, "test-token", { instanceId: "instance", projectId: "project", projectIdHash: "hash" });
      vi.spyOn(native, "getEngineCapabilities").mockReturnValue({ gameBuildFormats: ["web-zip"] });
      const result = await exportGame({ project }, { webOnlyConnect: async () => native });
      expect(result.storePlatform).toBe("web");
      expect(calls.map((call) => call.body.ops[0].op)).toEqual(["ExportGameBuild", "GameBuildStatus"]);
      expect(calls.every((call) => call.body.options.projectIdHash === "hash" && call.url.includes("projectIdentityVersion=1"))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it("refuses an older editor before starting a job", async () => {
    const executeIdentityBoundOps = vi.fn();
    await expect(exportGame({ project }, { webOnlyConnect: async () => ({ executeIdentityBoundOps, getEngineCapabilities: () => undefined }) })).rejects.toMatchObject({ code: "engine_web_export_unsupported" });
    expect(executeIdentityBoundOps).not.toHaveBeenCalled();
  });
  it.each([{ targets: ["macos"] }, { targets: ["web", "windows"] }, { format: "bundle" }, { debug: true }, { preset: "x" }])("rejects incompatible inputs %j before connecting", async (input) => {
    const connect = vi.fn();
    await expect(exportGame({ project, ...input }, { webOnlyConnect: connect })).rejects.toMatchObject({ code: "export_args_invalid" });
    expect(connect).not.toHaveBeenCalled();
  });
  it.each(["failed", "digest", "wrong-path"] as const)("does not publish an export record for %s", async (behavior) => {
    await expect(exportGame({ project }, { webOnlyConnect: async () => client(behavior) })).rejects.toBeTruthy();
    expect(await readLastExport()).toBeNull();
  });
  it("previews the recorded web artifact and rejects changed bytes", async () => {
    const result = await exportGame({ project }, { webOnlyConnect: async () => client() });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "game-1", name: "Game", status: "draft", supportedPlatforms: ["web"] }), { status: 200, headers: { "content-type": "application/json" } }));
    const options = { fetch: fetch as typeof globalThis.fetch, token: async () => "test-token", sleep: async () => undefined };
    const preview = await publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", face: "mcp" }, options);
    expect(preview).toMatchObject({ status: "confirmation_required", target: { file: result.path, platform: "web", sizeBytes: bytes.length } });
    await writeFile(result.path, Buffer.from("stale or replaced"));
    await expect(publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", face: "mcp" }, options)).rejects.toMatchObject({ code: "export_changed" });
  });
  it("rejects an invalid project marker before native export or implicit upload", async () => {
    await exportGame({ project }, { webOnlyConnect: async () => client() });
    await writeFile(join(project, ".summer/project.json"), "{invalid");
    const findBinary = vi.fn();
    await expect(exportGame({ project }, { findBinary })).rejects.toMatchObject({ code: "project_manifest_invalid" });
    expect(findBinary).not.toHaveBeenCalled();
    await expect(publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", face: "mcp" }))
      .rejects.toMatchObject({ code: "export_required" });
  });
  it("keeps the newer successful receipt when an older job completes later", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    let connected!: () => void;
    const started = new Promise<void>((resolveStarted) => { connected = resolveStarted; });
    const older = exportGame({ project }, { webOnlyConnect: async () => { connected(); await gate; return client(); } });
    await started;
    const newer = await exportGame({ project }, { webOnlyConnect: async () => client() });
    release();
    const oldResult = await older;
    expect(oldResult.path).not.toBe(newer.path);
    expect(await readLastExport()).toMatchObject({ path: newer.path, sha256: newer.sha256 });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "game-1", name: "Game", status: "draft", supportedPlatforms: ["web"] }), { status: 200, headers: { "content-type": "application/json" } }));
    const preview = await publishBuild(
      { gameId: "game-1", clientVersion: "v1.0.0", face: "mcp" },
      { fetch: fetch as typeof globalThis.fetch, token: async () => "test-token" }
    );
    expect(preview).toMatchObject({ status: "confirmation_required", target: { file: newer.path } });
  });
  it("blocks implicit upload of an earlier export after a later web build fails", async () => {
    const first = await exportGame({ project }, { webOnlyConnect: async () => client() });
    project = join(root, "other-game");
    await mkdir(join(project, ".summer"), { recursive: true });
    await writeFile(join(project, "project.godot"), "config_version=5\n");
    await writeFile(join(project, ".summer/project.json"), JSON.stringify({ kind: "web-only" }));
    await expect(exportGame({ project }, { webOnlyConnect: async () => client("failed") })).rejects.toBeTruthy();
    const options = { fetch: vi.fn(), token: async () => "test-token", sleep: async () => undefined };
    await expect(publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", face: "mcp" }, options)).rejects.toMatchObject({ code: "export_required" });
    expect(options.fetch).not.toHaveBeenCalled();
    expect(await readFile(first.path)).toEqual(bytes);
  });
  it("resumes the same content-addressed candidate after sealing without another create", async () => {
    await exportGame({ project }, { webOnlyConnect: async () => client() });
    const calls: string[] = [];
    let version: any;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET"; calls.push(`${method} ${url}`);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
      if (url.startsWith("https://r2.test/")) return new Response(null, { status: 200, headers: { etag: '"etag"' } });
      if (method === "GET" && url.includes("/store/versions?")) return json({ items: version ? [version] : [] });
      if (method === "POST" && url.endsWith("/store/versions")) { version = { id: "sv_1", ...body, status: "awaiting_upload" }; return json({ version, upload: { partSizeBytes: 16777216, partCount: 1 } }); }
      if (method === "GET" && url.endsWith("/sv_1/parts")) return json({ parts: [] });
      if (method === "POST" && url.endsWith("/sv_1:signParts")) return json({ parts: [{ partNumber: 1, method: "PUT", url: "https://r2.test/1", headers: {}, expiresAt: new Date(Date.now() + 3600000).toISOString() }] });
      if (method === "POST" && url.endsWith("/sv_1:complete")) { version.status = "processing"; return json({ version }); }
      if (method === "GET" && url.endsWith("/sv_1")) { version.status = "ready"; return json(version); }
      return new Response("not found", { status: 404 });
    });
    const options = { fetch: fetch as typeof globalThis.fetch, token: async () => "test-token", sleep: async () => undefined };
    const first = await publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", face: "mcp", confirm: true, waitSeconds: 0 }, options);
    expect(first.status).toBe("processing");
    const second = await publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", face: "mcp", confirm: true }, options);
    expect(second).toMatchObject({ status: "ready", versionId: "sv_1", resumed: true });
    expect(calls.filter((x) => x.startsWith("POST ") && x.endsWith("/store/versions"))).toHaveLength(1);
    expect(calls.filter((x) => x.includes(":complete"))).toHaveLength(1);
    expect(version.fileName).toBe(`web-${sha256.slice(7)}.zip`);
    await writeFile(join(root, "index.html"), "<html>new game</html>");
    await writeZip(join(root, "fixture-new.zip"), [{ name: "index.html", source: join(root, "index.html") }]);
    bytes = await readFile(join(root, "fixture-new.zip"));
    sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    await exportGame({ project }, { webOnlyConnect: async () => client() });
    const third = await publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", face: "mcp", confirm: true, waitSeconds: 0 }, options);
    expect(third.status).toBe("processing");
    expect(calls.filter((x) => x.startsWith("POST ") && x.endsWith("/store/versions"))).toHaveLength(2);
    expect(version.fileName).toBe(`web-${sha256.slice(7)}.zip`);
  });
  it("copies a verified job to an explicitly requested zip", async () => {
    const out = join(root, "chosen.zip");
    const result = await exportGame({ project, out, targets: ["web"], format: "download" }, { webOnlyConnect: async () => client() });
    expect(result.path).toBe(out);
    expect(await readFile(out)).toEqual(bytes);
  });
});
