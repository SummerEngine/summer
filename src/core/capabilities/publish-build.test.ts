import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSummerDir, setSummerDirForTests, writeStoreJson } from "../store.js";
import { writeSummerBundle } from "../../test-helpers/summer-bundle-fixture.js";
import { LAST_EXPORT_FILE } from "./export-game.js";
import { normalizeClientVersion, publishBuild, type PublishBuildDependencies } from "./publish-build.js";
import { BuildToolError } from "./summer-bundle.js";

const GATEWAY = "https://gateway.test";
const STORE = `${GATEWAY}/api/creator-store`;
const PUBLICATIONS = `${STORE}/games/game-1/build-publications`;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake creator store: the proxy routes Studio's export upload calls, plus R2 part PUTs. */
function fakeStore(options: {
  partSizeBytes?: number;
  startPhase?: "upload" | "inspecting";
  finalState?: string;
  errorCode?: string;
  publishStatus?: number;
  refuseAll?: number;
  refusePartOnce?: number;
  neverDone?: boolean;
} = {}) {
  const calls: Call[] = [];
  const parts = new Map<number, Buffer>();
  let sealed = options.startPhase === "inspecting";
  let polls = 0;
  let refused = false;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const raw = init.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    calls.push({ method, url, headers, body });
    if (url.startsWith("https://r2.test/")) {
      const partNumber = Number(url.split("/").pop());
      if (options.refusePartOnce === partNumber && !refused) {
        refused = true;
        return new Response("expired", { status: 403 });
      }
      parts.set(partNumber, Buffer.from(raw as Uint8Array));
      return new Response(null, { status: 200, headers: { etag: `"e${partNumber}"` } });
    }
    if (options.refuseAll) return json(options.refuseAll, { error: { code: "unauthorized", message: "Sign in to continue." } });
    if (method === "GET" && url === `${STORE}/games`) return json(200, { items: [{ id: "game-1", name: "Star Weavers", slug: "star-weavers", status: "draft" }] });
    if (method === "POST" && url === PUBLICATIONS) return json(202, { operationId: "op-1", publicationId: "pub-1", buildId: "build-1", state: "uploading" });
    if (method === "GET" && url === `${PUBLICATIONS}/pub-1`) {
      if (!sealed) return json(200, { id: "pub-1", state: "uploading", progress: { phase: "upload" } });
      polls += 1;
      if (options.neverDone || polls < 2) return json(200, { id: "pub-1", state: "uploading", progress: { phase: "inspecting" } });
      return json(200, { id: "pub-1", buildId: "build-1", state: options.finalState ?? "preview_ready", errorCode: options.errorCode ?? null });
    }
    if (method === "POST" && url === `${PUBLICATIONS}/pub-1:source-upload`) {
      const size = Number((globalThis as any).__bundleSize);
      const partSizeBytes = options.partSizeBytes ?? 64 * 1024 * 1024;
      return json(200, { sourceId: "src-1", upload: { partSizeBytes, partCount: Math.max(1, Math.ceil(size / partSizeBytes)) } });
    }
    if (method === "POST" && url === `${PUBLICATIONS}/pub-1:signParts`) {
      return json(200, {
        parts: body.parts.map((part: { partNumber: number; sha256: string }) => ({
          partNumber: part.partNumber,
          method: "PUT",
          url: `https://r2.test/part/${part.partNumber}`,
          headers: { "x-amz-checksum-sha256": part.sha256 },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })),
      });
    }
    if (method === "POST" && url === `${PUBLICATIONS}/pub-1:source-complete`) {
      sealed = true;
      return json(200, {});
    }
    if (method === "POST" && url === `${STORE}/games/game-1/builds/build-1/client-packages`) {
      return json(201, { package: { id: "pack-1" } });
    }
    if (method === "POST" && url === `${PUBLICATIONS}/pub-1:publish`) {
      return options.publishStatus === 409
        ? json(409, { error: { code: "deployment_not_actionable", message: "runtime approval pending" } })
        : json(200, {});
    }
    return json(404, { error: { code: "not_found" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, parts };
}

let root = "";
let bundle = "";
let bytes: Buffer;
const savedGateway = process.env.SUMMER_GATEWAY_URL;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-publish-build-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_GATEWAY_URL = GATEWAY;
  bundle = join(root, "game.zip");
  bytes = await writeSummerBundle(bundle, { clientPack: Buffer.from("GDPC".padEnd(5000, "c")) });
  (globalThis as any).__bundleSize = bytes.length;
});

afterEach(async () => {
  if (savedGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = savedGateway;
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

function deps(fetch: typeof globalThis.fetch, overrides: Partial<PublishBuildDependencies> = {}): Partial<PublishBuildDependencies> {
  return { fetch, sleep: async () => undefined, token: async () => "oauth-access-token", ...overrides };
}

async function failure(promise: Promise<unknown>): Promise<BuildToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BuildToolError) return error;
    throw error;
  }
  throw new Error("expected a BuildToolError");
}

const sha = (data: Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

describe("publishBuild", () => {
  it("previews the exact upload without touching the network until confirmed", async () => {
    const store = fakeStore();
    const result = await publishBuild({ gameId: "game-1", file: bundle, clientVersion: "v1.0.0", face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({
      ok: true,
      status: "confirmation_required",
      target: { gameId: "game-1", file: bundle, sha256: sha(bytes), sizeBytes: bytes.length, clientVersion: "v1.0.0", mainScene: "res://main.tscn", targetPlatforms: ["ios"], publish: false },
    });
    expect(store.calls).toEqual([]);
  });

  it("declares, uploads every part from disk, seals, waits and names the client pack", async () => {
    const store = fakeStore({ partSizeBytes: 2048, refusePartOnce: 2 });
    const result = await publishBuild(
      { gameId: "game-1", file: bundle, clientVersion: "1.2.0", confirm: true, face: "mcp" },
      deps(store.fetch)
    );
    expect(result).toMatchObject({
      ok: true,
      status: "uploaded",
      gameId: "game-1",
      publicationId: "pub-1",
      buildId: "build-1",
      clientPackageId: "pack-1",
      clientVersion: "v1.2.0",
      published: false,
    });

    const create = store.calls.find((call) => call.method === "POST" && call.url === PUBLICATIONS)!;
    expect(create.headers.authorization).toBe("Bearer oauth-access-token");
    expect(create.headers["idempotency-key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(create.body).toEqual({
      source: { kind: "exported-game", format: "summer-bundle", archiveSha256: sha(bytes), sizeBytes: bytes.length },
      clientVersion: "v1.2.0",
      build: { version: "v1.2.0", executionMode: "standalone", targetPlatforms: ["ios"], client: { entryPoint: "res://main.tscn" } },
    });

    // Every part arrived once, bound to its own digest; the refused part was re-signed.
    const partCount = Math.ceil(bytes.length / 2048);
    expect([...store.parts.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: partCount }, (_, i) => i + 1));
    expect(Buffer.concat([...store.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part)).equals(bytes)).toBe(true);
    const signed = store.calls.filter((call) => call.url.endsWith(":signParts")).flatMap((call) => call.body.parts);
    expect(signed.find((part: any) => part.partNumber === 1).sha256).toBe(sha(bytes.subarray(0, 2048)));
    expect(signed.filter((part: any) => part.partNumber === 2).length).toBe(2);

    const seal = store.calls.find((call) => call.url.endsWith(":source-complete"))!;
    expect(seal.headers["idempotency-key"]).toMatch(/^[0-9a-f]{64}$/);
    const pack = store.calls.find((call) => call.url.endsWith("/client-packages"))!;
    expect(pack.body).toMatchObject({ mainScene: "res://main.tscn", version: "v1.2.0", clientSize: 5000 });
    expect(store.calls.some((call) => call.url.endsWith(":publish"))).toBe(false);

    const audit = (await readFile(join(getSummerDir(), "creator-audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.map((row) => row.outcome)).toEqual(["started", "succeeded"]);
    expect(audit[0]).toMatchObject({ operation: "publish_build", gameId: "game-1", sha256: sha(bytes) });
  });

  it("keeps the same idempotency keys on a retry, so the same publication continues", async () => {
    const first = fakeStore();
    await publishBuild({ gameId: "game-1", file: bundle, clientVersion: "v1.0.0", confirm: true, face: "mcp" }, deps(first.fetch));
    const second = fakeStore({ startPhase: "inspecting" });
    await publishBuild({ gameId: "game-1", file: bundle, clientVersion: "v1.0.0", confirm: true, face: "mcp" }, deps(second.fetch));
    const key = (calls: Call[]) => calls.find((call) => call.url === PUBLICATIONS)!.headers["idempotency-key"];
    expect(key(second.calls)).toBe(key(first.calls));
    // Already sealed: nothing is uploaded again.
    expect(second.calls.some((call) => call.url.endsWith(":source-upload") || call.url.startsWith("https://r2.test/"))).toBe(false);
  });

  it("publishes when asked, and says when the game still waits for review", async () => {
    const approved = fakeStore();
    expect(
      await publishBuild({ gameId: "game-1", file: bundle, clientVersion: "v1.0.0", publish: true, confirm: true, face: "mcp" }, deps(approved.fetch))
    ).toMatchObject({ status: "published", published: true });

    const waiting = fakeStore({ publishStatus: 409 });
    expect(
      await publishBuild({ gameId: "game-1", file: bundle, clientVersion: "v1.0.0", publish: true, confirm: true, face: "mcp" }, deps(waiting.fetch))
    ).toMatchObject({ status: "uploaded", published: false, publishNote: expect.stringContaining("review") });
  });

  it("explains a refused sign-in (the store does not accept agent tokens yet)", async () => {
    const store = fakeStore({ refuseAll: 401 });
    const error = await failure(
      publishBuild({ gameId: "game-1", file: bundle, clientVersion: "v1.0.0", confirm: true, face: "mcp" }, deps(store.fetch))
    );
    expect(error.code).toBe("store_auth_refused");
    expect(error.recovery).toContain("summer login --store --force");
    expect(error.recovery).toContain("Studio");
  });

  it("needs a store sign-in before uploading", async () => {
    const store = fakeStore();
    const error = await failure(
      publishBuild(
        { gameId: "game-1", file: bundle, clientVersion: "v1.0.0", confirm: true, face: "mcp" },
        { fetch: store.fetch, sleep: async () => undefined }
      )
    );
    expect(error.code).toBe("store_login_required");
    expect(store.calls).toEqual([]);
  });

  it("lists the creator's games when gameId is missing", async () => {
    const store = fakeStore();
    const error = await failure(publishBuild({ file: bundle, clientVersion: "v1.0.0", face: "mcp" }, deps(store.fetch)));
    expect(error.code).toBe("game_required");
    expect(error.detail?.games).toEqual([{ id: "game-1", name: "Star Weavers", slug: "star-weavers", status: "draft" }]);
  });

  it("reports why Summer did not make a Build", async () => {
    const store = fakeStore({ finalState: "failed", errorCode: "client_version_conflict" });
    const error = await failure(
      publishBuild({ gameId: "game-1", file: bundle, clientVersion: "v1.0.0", confirm: true, face: "mcp" }, deps(store.fetch))
    );
    expect(error.code).toBe("client_version_conflict");
    expect(error.message).toContain("new clientVersion");
  });

  it("returns while Summer is still checking, with how to continue", async () => {
    const store = fakeStore({ neverDone: true });
    let clock = 0;
    const result = await publishBuild(
      { gameId: "game-1", file: bundle, clientVersion: "v1.0.0", confirm: true, waitSeconds: 5, face: "mcp" },
      deps(store.fetch, { now: () => clock, sleep: async () => void (clock += 3000) })
    );
    expect(result).toMatchObject({ ok: true, status: "processing", publicationId: "pub-1" });
  });

  it("uploads the last export by default and checks its inputs", async () => {
    await writeStoreJson(LAST_EXPORT_FILE, { path: bundle, project: root, sha256: sha(bytes), sizeBytes: bytes.length, exportedAt: "now" });
    const store = fakeStore();
    expect(await publishBuild({ gameId: "game-1", clientVersion: "v2.0.0", face: "cli" }, deps(store.fetch))).toMatchObject({
      status: "confirmation_required",
      target: { file: bundle },
    });

    const macos = join(root, "macos.zip");
    await writeSummerBundle(macos, { targetPlatforms: ["ios", "macos"] });
    expect((await failure(publishBuild({ gameId: "game-1", file: macos, clientVersion: "v1.0.0", face: "mcp" }, deps(store.fetch)))).code).toBe(
      "platforms_unsupported"
    );
    const phones = join(root, "phones.zip");
    await writeSummerBundle(phones, { targetPlatforms: ["ios", "android"] });
    expect(await publishBuild({ gameId: "game-1", file: phones, clientVersion: "v1.0.0", face: "mcp" }, deps(store.fetch))).toMatchObject({
      target: { hosted: false, targetPlatforms: ["ios", "android"] },
    });
    const hosted = join(root, "hosted.zip");
    await writeSummerBundle(hosted, { hosted: true, targetPlatforms: ["ios", "macos"] });
    expect(await publishBuild({ gameId: "game-1", file: hosted, clientVersion: "v1.0.0", face: "mcp" }, deps(store.fetch))).toMatchObject({
      target: { hosted: true, targetPlatforms: ["ios", "macos"] },
    });
  });

  it("accepts Summer client versions only", () => {
    expect(normalizeClientVersion("v1.0.0")).toBe("v1.0.0");
    expect(normalizeClientVersion("1.0.0-r2")).toBe("v1.0.0-r2");
    expect(() => normalizeClientVersion("1.0")).toThrow(/vMAJOR\.MINOR\.PATCH/);
    expect(() => normalizeClientVersion(undefined)).toThrow(BuildToolError);
  });
});
