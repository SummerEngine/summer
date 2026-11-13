import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSummerDir, setSummerDirForTests } from "../store.js";
import { publishBuild, type PublishBuildDependencies } from "./publish-build.js";
import { BuildToolError } from "./summer-bundle.js";

const GATEWAY = "https://gateway.test";
const STORE = `${GATEWAY}/api/creator-store`;
const BUILD = `${STORE}/games/game-1/builds/build-1`;
const CLIENTS = `${BUILD}/client-packages`;
const PART = 2048;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

/**
 * A fake creator store for the clients of one Build: the Build read, the
 * client-packages routes and storage part PUTs. A client moves the way the
 * store moves it: awaiting_upload until sealed, verifying while Summer reads
 * it, then uploaded with its qualification, or rejected with the store's code.
 */
function fakeStore(options: {
  /** The Build's server: a program (default), or a Summer Engine export. */
  server?: "program" | "engine";
  noBuild?: boolean;
  /** The store refuses the declaration. */
  declare?: { status: number; code: string; message: string };
  /** The store refuses :complete. */
  complete?: { status: number; code: string; message: string };
  /** :complete answers 409 upload_expired this many times first. */
  expired?: number;
  /** The first storage session is gone: storage answers its part PUTs 404, and the store forgets it only when asked to complete it. */
  deadSession?: boolean;
  /** Storage refuses every part while the session is alive (a broken connection, not an ended session). */
  brokenStorage?: boolean;
  /** The person's Agent permissions (GET me/agent-permissions); absent answers 404. */
  agentPermissions?: Record<string, unknown>;
  /** Reads that answer verifying before the outcome (default 1); Infinity never settles. */
  verifyingReads?: number;
  /** Summer rejects the archive after reading it. */
  reject?: { code: string; message: string };
  /** The client was already sealed by an earlier call. */
  sealed?: boolean;
} = {}) {
  const calls: Call[] = [];
  const parts = new Map<number, Buffer>();
  let declaration: Record<string, any> | null = null;
  let state = options.sealed ? "verifying" : "awaiting_upload";
  let reads = 0;
  let expired = 0;
  // Each declaration of a client that still awaits its bytes hands out the current storage session.
  let session = 1;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const refuse = (refusal: { status: number; code: string; message: string }) => json(refusal.status, { error: { code: refusal.code, message: refusal.message } });
  const client = () => ({
    id: "client-1",
    gameId: "game-1",
    buildId: "build-1",
    ...declaration,
    state,
    ...(state === "uploaded" ? { qualificationId: "qual-1" } : {}),
    ...(state === "rejected" && options.reject ? { verificationError: options.reject.code, verificationMessage: options.reject.message } : {}),
  });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const raw = init.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    calls.push({ method, url, headers, body });
    if (url.startsWith("https://r2.test/")) {
      const of = Number(url.split("/")[3]!.slice(1));
      if (options.brokenStorage || (options.deadSession && of === 1)) return new Response("NoSuchUpload", { status: 404 });
      if (of !== session) return new Response("NoSuchUpload", { status: 404 });
      parts.set(Number(url.split("/").pop()), Buffer.from(raw as Uint8Array));
      return new Response(null, { status: 200 });
    }
    if (method === "GET" && url === `${STORE}/me/agent-permissions`) return options.agentPermissions ? json(200, options.agentPermissions) : json(404, { error: { code: "not_found" } });
    if (method === "GET" && url === `${STORE}/games`) return json(200, { items: [{ id: "game-1", name: "Star Weavers", slug: "star-weavers", status: "draft", supportedPlatforms: ["macos"] }] });
    if (method === "GET" && url === `${STORE}/games/game-1`) return json(200, { id: "game-1", name: "Star Weavers", status: "draft", supportedPlatforms: ["macos", "windows", "web"] });
    if (method === "GET" && url === BUILD) {
      if (options.noBuild) return json(404, { error: { code: "not_found", message: "resource not found" } });
      return json(200, { id: "build-1", gameId: "game-1", version: "0.3.0", status: "ready", executionMode: "hosted", targetPlatforms: [], manifest: options.server === "engine" ? { protocolVersion: "1.0.0" } : { protocolVersion: "1.0.0", serverKind: "program" } });
    }
    if (method === "POST" && url === CLIENTS) {
      if (options.declare) return refuse(options.declare);
      declaration = body;
      const size = Number(body.clientSize);
      return json(200, { package: client(), ...(state === "awaiting_upload" ? { upload: { partSizeBytes: PART, partCount: Math.max(1, Math.ceil(size / PART)) } } : {}) });
    }
    if (method === "POST" && url === `${CLIENTS}/client-1:signParts`) {
      return json(200, {
        parts: body.parts.map((part: { partNumber: number; sha256: string }) => ({
          partNumber: part.partNumber,
          method: "PUT",
          url: `https://r2.test/s${session}/part/${part.partNumber}`,
          headers: { "x-amz-checksum-sha256": part.sha256 },
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })),
      });
    }
    if (method === "POST" && url === `${CLIENTS}/client-1:complete`) {
      if (options.complete) return refuse(options.complete);
      if (expired < (options.expired ?? 0) || (options.deadSession && session === 1)) {
        expired += 1;
        // Only now does the store forget the ended session: the next declaration opens a new one.
        session += 1;
        parts.clear();
        return json(409, { error: { code: "upload_expired", message: "the storage session of this upload ended" } });
      }
      const size = Number(declaration?.clientSize ?? 0);
      if (parts.size !== Math.max(1, Math.ceil(size / PART))) return json(409, { error: { code: "upload_incomplete", message: "storage does not hold every part" } });
      state = "verifying";
      return json(200, client());
    }
    if (method === "GET" && url === `${CLIENTS}/client-1`) {
      reads += 1;
      if (state === "verifying" && reads > (options.verifyingReads ?? 1)) state = options.reject ? "rejected" : "uploaded";
      return json(200, client());
    }
    return json(404, { error: { code: "not_found" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, parts };
}

let root = "";
let archive = "";
let bytes: Buffer;
const savedGateway = process.env.SUMMER_GATEWAY_URL;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-publish-client-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_GATEWAY_URL = GATEWAY;
  archive = join(root, "game-macos.zip");
  // The store reads the archive; this package only sends it, so any bytes do.
  bytes = Buffer.from(Array.from({ length: 5000 }, (_, index) => index % 251));
  await writeFile(archive, bytes);
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
const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");
const mac = { gameId: "game-1", buildId: "build-1", platform: "macos", entry: "Game.app", clientVersion: "v1.0.0", face: "mcp" as const };

describe("publishBuild with buildId: a client of a Build whose server is a program", () => {
  it("previews the exact upload after reading the game and the Build, and uploads nothing until confirmed", async () => {
    const store = fakeStore();
    const result = await publishBuild({ ...mac, file: archive }, deps(store.fetch));
    expect(result).toMatchObject({
      ok: true,
      status: "confirmation_required",
      target: { gameId: "game-1", buildId: "build-1", file: archive, platform: "macos", entry: "Game.app", clientVersion: "v1.0.0", sha256: sha(bytes), sizeBytes: bytes.length, kind: "program" },
      build: { buildId: "build-1", version: "0.3.0", status: "ready", serverKind: "program" },
      game: { gameId: "game-1", name: "Star Weavers" },
    });
    expect(writes(store.calls)).toEqual([]);
  });

  it("declares the kind the Build takes, uploads every part from disk, seals, and waits until Summer admitted it", async () => {
    const store = fakeStore({ verifyingReads: 2 });
    const result = await publishBuild({ ...mac, file: archive, clientVersion: "1.0.0", confirm: true }, deps(store.fetch));

    const declared = store.calls.find((call) => call.method === "POST" && call.url === CLIENTS)!;
    expect(declared.headers.authorization).toBe("Bearer oauth-access-token");
    expect(declared.body).toEqual({ kind: "program", platform: "macos", clientSha256: sha(bytes), clientSize: bytes.length, version: "v1.0.0", entry: "Game.app", host: { interface: 6 } });

    const partCount = Math.ceil(bytes.length / PART);
    expect([...store.parts.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: partCount }, (_, index) => index + 1));
    expect(Buffer.concat([...store.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part)).equals(bytes)).toBe(true);
    const signed = store.calls.filter((call) => call.url === `${CLIENTS}/client-1:signParts`).flatMap((call) => call.body.parts);
    expect(signed.find((part: any) => part.partNumber === 2).sha256).toBe(sha(bytes.subarray(PART, 2 * PART)));
    // Storage gets only the signed headers: never the store sign-in.
    expect(store.calls.filter((call) => call.url.startsWith("https://r2.test/")).every((call) => !("authorization" in call.headers))).toBe(true);
    expect(store.calls.filter((call) => call.url === `${CLIENTS}/client-1:complete`).map((call) => call.body)).toEqual([{}]);

    expect(result).toMatchObject({ ok: true, status: "uploaded", gameId: "game-1", buildId: "build-1", clientPackageId: "client-1", kind: "program", platform: "macos", entry: "Game.app", clientVersion: "v1.0.0", qualificationId: "qual-1", uploaded: true });
    // The answer carries what releases this client: go-live's own input, with the id.
    expect(result.goLive).toEqual({ gameId: "game-1", clients: ["client-1"] });
    expect(String(result.next)).toContain('summer_go_live with gameId game-1 and clients ["client-1"]');
    expect(String(result.next)).toContain("summer store go-live --game-id game-1 --clients client-1");
    expect(String(result.next)).toContain("Nothing is released yet");

    // Nothing is kept on this computer about the client but the audit line of the call.
    expect((await readdir(getSummerDir())).sort()).toEqual(["creator-audit.jsonl"]);
    const audit = (await readFile(join(getSummerDir(), "creator-audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.map((row) => [row.operation, row.outcome])).toEqual([["publish_client", "started"], ["publish_client", "succeeded"]]);
  });

  it("sends a browser build as the web client, starting at index.html", async () => {
    const store = fakeStore();
    const result = await publishBuild({ gameId: "game-1", buildId: "build-1", platform: "web", clientVersion: "v1.0.0", file: archive, confirm: true, face: "cli" }, deps(store.fetch));
    expect(store.calls.find((call) => call.method === "POST" && call.url === CLIENTS)!.body).toMatchObject({ kind: "program", platform: "web", entry: "index.html", host: { interface: 6 } });
    expect(result).toMatchObject({ status: "uploaded", platform: "web", entry: "index.html" });
  });

  it("finds a client Summer already has instead of sending it again", async () => {
    const store = fakeStore({ sealed: true });
    const result = await publishBuild({ ...mac, file: archive, confirm: true }, deps(store.fetch));
    expect(result).toMatchObject({ status: "uploaded", clientPackageId: "client-1", qualificationId: "qual-1", uploaded: false });
    expect(writes(store.calls).map((call) => call.url)).toEqual([CLIENTS]);
  });

  it("starts the upload again when its storage session ended: storage refuses the parts, the store forgets the session, a new one takes every part", async () => {
    const store = fakeStore({ deadSession: true });
    const result = await publishBuild({ ...mac, file: archive, confirm: true }, deps(store.fetch));
    expect(result).toMatchObject({ status: "uploaded", clientPackageId: "client-1", qualificationId: "qual-1" });
    // Declared, refused by storage, asked to complete (which is what makes the store forget the session), declared again.
    expect(writes(store.calls).filter((call) => !call.url.startsWith("https://r2.test/") && !call.url.endsWith(":signParts")).map((call) => call.url)).toEqual([CLIENTS, `${CLIENTS}/client-1:complete`, CLIENTS, `${CLIENTS}/client-1:complete`]);
    expect(store.calls.some((call) => call.url.startsWith("https://r2.test/s1/"))).toBe(true);
    expect(Buffer.concat([...store.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part)).equals(bytes)).toBe(true);
  });

  it("starts again too when the session ends between the last part and the seal", async () => {
    const store = fakeStore({ expired: 1 });
    const result = await publishBuild({ ...mac, file: archive, confirm: true }, deps(store.fetch));
    expect(result).toMatchObject({ status: "uploaded", clientPackageId: "client-1" });
    expect(store.calls.filter((call) => call.method === "POST" && call.url === CLIENTS).length).toBe(2);
    expect(Buffer.concat([...store.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part)).equals(bytes)).toBe(true);
  });

  it("answers the part's own failure when storage refuses parts of a session that is alive, and says every part is sent again", async () => {
    const store = fakeStore({ brokenStorage: true });
    const error = await failure(publishBuild({ ...mac, file: archive, confirm: true }, deps(store.fetch)));
    expect(error.code).toBe("store_part_upload_failed");
    expect(error.recovery).toContain("parts are all sent again");
    expect(error.recovery).not.toContain("continues where it stopped");
    // The session was alive, so nothing was declared a second time.
    expect(store.calls.filter((call) => call.method === "POST" && call.url === CLIENTS).length).toBe(1);
  });

  it("answers processing, with how to continue, while Summer still reads the archive", async () => {
    let clock = 0;
    const store = fakeStore({ verifyingReads: Infinity });
    const result = await publishBuild({ ...mac, file: archive, confirm: true, waitSeconds: 5 }, deps(store.fetch, { now: () => clock, sleep: async (ms) => void (clock += ms) }));
    expect(result).toMatchObject({ ok: true, status: "processing", clientPackageId: "client-1", state: "verifying" });
    expect(String(result.next)).toMatch(/nothing is uploaded twice/);
  });

  it("answers a rejected archive with the store's own code and message", async () => {
    const message = "the archive does not hold Game.app/Contents/Info.plist";
    const store = fakeStore({ reject: { code: "client_entry_missing", message } });
    const error = await failure(publishBuild({ ...mac, file: archive, confirm: true }, deps(store.fetch)));
    expect(error.code).toBe("client_entry_missing");
    expect(error.message).toContain(message);
    expect(error.recovery).toContain("new clientVersion");
    expect(error.detail).toMatchObject({ clientPackageId: "client-1", failedCheck: { code: "client_entry_missing", owner: "creator" } });
  });

  it("passes the store's refusal of a browser build for a game with a price through", async () => {
    const message = "this game has a price, so it takes no browser build yet";
    const store = fakeStore({ declare: { status: 409, code: "web_client_game_priced", message } });
    const error = await failure(publishBuild({ gameId: "game-1", buildId: "build-1", platform: "web", clientVersion: "v1.0.0", file: archive, confirm: true, face: "mcp" }, deps(store.fetch)));
    expect(error.code).toBe("web_client_game_priced");
    expect(error.status).toBe(409);
    expect(error.message).toContain(message);
    expect(store.calls.some((call) => call.url.startsWith("https://r2.test/"))).toBe(false);
  });

  it("passes the store's refusal through when it does not let an agent sign-in finish the upload, and says what lifts it: Publish", async () => {
    const store = fakeStore({ complete: { status: 403, code: "owner_approval_required", message: "This sign-in cannot finish a client upload; the game's owner can." } });
    const error = await failure(publishBuild({ ...mac, file: archive, confirm: true }, deps(store.fetch)));
    expect(error.code).toBe("owner_approval_required");
    expect(error.status).toBe(403);
    expect(error.message).toContain("This sign-in cannot finish a client upload");
    expect(error.recovery).toContain("turns on Publish under Agent permissions in Summer Studio");
    // Nothing is promised that does not exist: no approval link for this call, no upload of such a client from Summer Studio.
    expect(error.recovery).not.toMatch(/approval link/i);
    expect(error.recovery).not.toMatch(/upload .* from Summer Studio/i);
  });

  it("warns in the preview, before any byte is sent, when Publish is off for agents", async () => {
    const off = fakeStore({ agentPermissions: { publish: false, makeAndBuild: true } });
    const preview = await publishBuild({ ...mac, file: archive }, deps(off.fetch));
    expect(preview.status).toBe("confirmation_required");
    expect(String((preview.warnings as string[])[0])).toMatch(/Publish is off.*turns on Publish under Agent permissions in Summer Studio/);
    expect(writes(off.calls)).toEqual([]);

    // On, or not told: no warning, and the store decides at the upload.
    for (const store of [fakeStore({ agentPermissions: { publish: true } }), fakeStore()]) {
      expect((await publishBuild({ ...mac, file: archive }, deps(store.fetch))).warnings).toBeUndefined();
    }
  });

  it("says a missing file or a folder is not a file, before any call", async () => {
    const store = fakeStore();
    await mkdir(join(root, "folder.zip"));
    for (const file of [join(root, "nothing.zip"), join(root, "folder.zip")]) {
      const error = await failure(publishBuild({ ...mac, file, confirm: true }, deps(store.fetch)));
      expect(error.code).toBe("file_not_found");
      expect(error.message).toContain("is not a file on this computer");
    }
    expect(store.calls).toEqual([]);
  });

  it("uploads no separate client to a Build with a Summer Engine server, and says what to upload instead", async () => {
    const store = fakeStore({ server: "engine" });
    for (const confirm of [false, true]) {
      const error = await failure(publishBuild({ ...mac, file: archive, confirm }, deps(store.fetch)));
      expect(error.code).toBe("build_takes_no_separate_client");
      expect(error.message).toContain("Summer Engine server");
      expect(error.recovery).toContain("without buildId");
    }
    expect(writes(store.calls)).toEqual([]);
  });

  it("says so when the game has no such Build", async () => {
    const store = fakeStore({ noBuild: true });
    const error = await failure(publishBuild({ ...mac, file: archive, confirm: true }, deps(store.fetch)));
    expect(error.code).toBe("build_not_found");
    expect(error.message).toContain('"build-1"');
    expect(writes(store.calls)).toEqual([]);
  });

  it("asks for what only the caller knows before any call: the platform, the entry and the version", async () => {
    const store = fakeStore();
    const base = { gameId: "game-1", buildId: "build-1", file: archive, confirm: true, face: "mcp" as const };
    const noPlatform = await failure(publishBuild({ ...base, entry: "Game.app", clientVersion: "v1.0.0" }, deps(store.fetch)));
    expect(noPlatform.code).toBe("platform_invalid");
    expect(noPlatform.recovery).toContain("macos, windows, web");
    // A store download's platform name is not a Build client's.
    const download = await failure(publishBuild({ ...base, platform: "macos-universal", entry: "Game.app", clientVersion: "v1.0.0" }, deps(store.fetch)));
    expect(download.code).toBe("platform_invalid");
    expect(download.message).toContain('"macos-universal"');
    const noEntry = await failure(publishBuild({ ...base, platform: "windows", clientVersion: "v1.0.0" }, deps(store.fetch)));
    expect(noEntry.code).toBe("entry_required");
    const noVersion = await failure(publishBuild({ ...base, platform: "macos", entry: "Game.app" }, deps(store.fetch)));
    expect(noVersion.code).toBe("client_version_invalid");
    expect(store.calls).toEqual([]);
  });

  it("does not take an entry without a buildId for a store download", async () => {
    const store = fakeStore();
    const error = await failure(publishBuild({ gameId: "game-1", file: archive, platform: "macos-universal", entry: "Game.app", clientVersion: "v1.0.0", confirm: true, face: "mcp" }, deps(store.fetch)));
    expect(error.code).toBe("build_required");
    expect(store.calls).toEqual([]);
  });

  it("lists the creator's games when gameId is missing", async () => {
    const store = fakeStore();
    const error = await failure(publishBuild({ buildId: "build-1", platform: "macos", entry: "Game.app", clientVersion: "v1.0.0", file: archive, face: "mcp" }, deps(store.fetch)));
    expect(error.code).toBe("game_required");
    expect(writes(store.calls)).toEqual([]);
  });
});
