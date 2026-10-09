import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSummerDirForTests, writeStoreJson } from "../store.js";
import { writeZip } from "../util/zip-write.js";
import { LAST_EXPORT_FILE } from "./export-game.js";
import { publishBuild, type PublishBuildDependencies } from "./publish-build.js";
import { BuildToolError } from "./summer-bundle.js";

const GATEWAY = "https://gateway.test";
const VERSIONS = `${GATEWAY}/api/creator-store/games/game-1/store/versions`;
const WEB_PART = 16 * 1024 * 1024;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake creator store for store versions (summer-platform creatorstore), plus storage part PUTs. */
function fakeStore(options: { existing?: Record<string, unknown>; storedParts?: number[]; completeStatus?: number; reject?: string } = {}) {
  const calls: Call[] = [];
  const put = new Set<number>(options.storedParts ?? []);
  let status = (options.existing?.status as string) ?? "none";
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const version = () => ({ id: "sv_1", platform: "web", label: "v1.0.0", fileName: "game-web.zip", sizeBytes: Number((globalThis as any).__webSize), status, ...(options.reject && status === "rejected" ? { rejectionReason: options.reject } : {}), ...(status === "ready" ? { playUrl: "https://play.test/g/game-1/v1" } : {}) });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, headers, body });
    if (url.startsWith("https://r2.test/")) {
      put.add(Number(url.split("/").pop()));
      return new Response(null, { status: 200, headers: { etag: '"e"' } });
    }
    if (method === "GET" && url.endsWith("/api/creator-store/games/game-1")) return json(200, { id: "game-1", name: "Star Weavers", status: "draft", supportedPlatforms: ["web"] });
    if (method === "GET" && url === `${VERSIONS}?platform=web`) return json(200, { items: options.existing ? [version()] : [] });
    if (method === "POST" && url === VERSIONS) {
      status = "awaiting_upload";
      const size = Number((globalThis as any).__webSize);
      return json(201, { version: version(), upload: { uploadId: "u1", partSizeBytes: WEB_PART, partCount: Math.max(1, Math.ceil(size / WEB_PART)) } });
    }
    if (method === "GET" && url === `${VERSIONS}/sv_1/parts`) {
      return json(200, { parts: [...put].map((partNumber) => ({ partNumber, etag: '"e"', sizeBytes: Number((globalThis as any).__webSize) })) });
    }
    if (method === "POST" && url === `${VERSIONS}/sv_1:signParts`) {
      return json(200, { parts: body.partNumbers.map((n: number) => ({ partNumber: n, method: "PUT", url: `https://r2.test/part/${n}`, headers: {}, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })) });
    }
    if (method === "POST" && url === `${VERSIONS}/sv_1:complete`) {
      if (options.completeStatus === 403) return json(403, { error: { code: "owner_approval_required", message: "This game is live; a finished upload goes live at once. The owner finishes it in Studio." } });
      status = "processing";
      return json(200, { version: version() });
    }
    if (method === "GET" && url === `${VERSIONS}/sv_1`) {
      status = options.reject ? "rejected" : "ready";
      return json(200, version());
    }
    return json(404, { error: { code: "not_found" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, put };
}

let root = "";
let webZip = "";
const savedGateway = process.env.SUMMER_GATEWAY_URL;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-publish-download-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_GATEWAY_URL = GATEWAY;
  await writeFile(join(root, "index.html"), "<!doctype html><title>game</title>");
  await writeFile(join(root, "game.pck"), Buffer.alloc(4000, 7));
  webZip = join(root, "game-web.zip");
  const written = await writeZip(webZip, [
    { name: "index.html", source: join(root, "index.html") },
    { name: "game.pck", source: join(root, "game.pck") },
  ]);
  (globalThis as any).__webSize = written.bytes;
  // summer_export_game format "download" records the platform with the file.
  await writeStoreJson(LAST_EXPORT_FILE, { path: webZip, project: root, sha256: "sha256:x", sizeBytes: written.bytes, exportedAt: "now", storePlatform: "web" });
});

afterEach(async () => {
  if (savedGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = savedGateway;
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

const deps = (fetch: typeof globalThis.fetch): Partial<PublishBuildDependencies> => ({ fetch, sleep: async () => undefined, token: async () => "oauth-access-token" });

async function failure(promise: Promise<unknown>): Promise<BuildToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BuildToolError) return error;
    throw error;
  }
  throw new Error("expected a BuildToolError");
}

describe("summer_publish_build: web builds and native downloads (store versions)", () => {
  it("previews the last download export with its platform, checks the game and sends nothing before confirm", async () => {
    const store = fakeStore();
    const result = await publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", face: "mcp" }, deps(store.fetch));
    expect(result.status).toBe("confirmation_required");
    expect(result.target).toMatchObject({ platform: "web", fileName: "game-web.zip", fileCount: 2 });
    expect(result.game).toMatchObject({ gameId: "game-1", name: "Star Weavers" });
    expect(store.calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("creates the version, uploads every part with the store sign-in, completes it and waits until ready", async () => {
    const store = fakeStore();
    const result = await publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ ok: true, status: "ready", versionId: "sv_1", platform: "web", playUrl: "https://play.test/g/game-1/v1" });
    const create = store.calls.find((call) => call.method === "POST" && call.url === VERSIONS)!;
    expect(create.body).toEqual({ platform: "web", fileName: "game-web.zip", sizeBytes: (globalThis as any).__webSize, label: "v1.0.0" });
    expect(create.headers.authorization).toBe("Bearer oauth-access-token");
    expect(store.put).toEqual(new Set([1]));
    expect(store.calls.some((call) => call.url === `${VERSIONS}/sv_1:complete`)).toBe(true);
    // Store versions never call a publish route.
    expect(store.calls.some((call) => call.url.includes(":publish"))).toBe(false);
  });

  it("continues an unfinished upload of the same file and skips parts storage already has", async () => {
    const store = fakeStore({ existing: { status: "awaiting_upload" }, storedParts: [1] });
    const result = await publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "ready", resumed: true });
    expect(store.calls.some((call) => call.method === "POST" && call.url === VERSIONS)).toBe(false);
    expect(store.calls.some((call) => call.url.startsWith("https://r2.test/"))).toBe(false);
  });

  it("says plainly when the owner must finish an upload on a live game", async () => {
    const store = fakeStore({ completeStatus: 403 });
    const error = await failure(publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", confirm: true, face: "mcp" }, deps(store.fetch)));
    expect(error.code).toBe("owner_approval_required");
    expect(error.message).toContain("owner finishes it in Studio");
  });

  it("refuses a web zip without index.html before uploading", async () => {
    const other = join(root, "no-index.zip");
    await writeZip(other, [{ name: "game.pck", source: join(root, "game.pck") }]);
    const store = fakeStore();
    const error = await failure(publishBuild({ gameId: "game-1", file: other, platform: "web", clientVersion: "v1.0.0", confirm: true, face: "mcp" }, deps(store.fetch)));
    expect(error.code).toBe("web_entry_missing");
    expect(store.calls).toEqual([]);
  });

  it("reports the store's reason when it rejects the file", async () => {
    const store = fakeStore({ reject: "index.html is missing a canvas" });
    const error = await failure(publishBuild({ gameId: "game-1", clientVersion: "v1.0.0", confirm: true, face: "mcp" }, deps(store.fetch)));
    expect(error.code).toBe("download_rejected");
    expect(error.message).toContain("canvas");
  });
});
