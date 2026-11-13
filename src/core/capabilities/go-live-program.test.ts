import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSummerDirForTests } from "../store.js";
import { recordBuildClient } from "./build-clients.js";
import { goLive } from "./go-live.js";
import type { PublishBuildDependencies } from "./publish-build.js";
import { BuildToolError } from "./summer-bundle.js";

const GATEWAY = "https://gateway.test";
const STORE = `${GATEWAY}/api/creator-store`;
const GAME = `${STORE}/games/game-1`;
const ENV = `${GAME}/environments/env_production`;
const BUILD = `${GAME}/builds/build-1`;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

type Client = { platform: string; state: string; qualificationId?: string; verificationError?: string; verificationMessage?: string };

/**
 * A fake creator store for a game not made with Summer Engine: one store page
 * revision, one published Build whose server is a program (its publication
 * has no client pack and names no platform), that Build's clients by id, the
 * production environment and Summer's review. A release takes the members the
 * draft selected, as the platform does.
 */
function fakeStore(options: {
  /** The Build's clients as the store holds them, by client id. */
  clients?: Record<string, Client>;
  /** What players have now: the live release's members of this Build. */
  live?: Array<{ target: string; qualificationId: string }>;
  /** The store refuses the release. */
  release?: { status: number; code: string; message: string };
} = {}) {
  const calls: Call[] = [];
  const page: Record<string, any> = {
    revisionId: "rev-1",
    sequence: 1,
    state: options.live ? "PUBLISHED" : "DRAFT",
    etagRevision: 4,
    presentation: { name: "Star Weavers", description: "Weave stars into constellations with friends." },
    supportedPlatforms: ["macos", "windows", "web"],
    contentRating: "everyone",
    contentDescriptors: [],
  };
  const environment: Record<string, any> = { id: "env_production", kind: "production", status: "active", revision: 7, activeReleaseId: options.live ? "rel-0" : null, desiredReleaseId: options.live ? "rel-0" : null };
  const releases: Record<string, Record<string, any>> = options.live
    ? { "rel-0": { id: "rel-0", status: "active", targets: options.live.map((member) => ({ ...member, buildId: "build-1" })), server: { buildId: "build-1" } } }
    : {};
  // A program publication: exported-game, hosted, published, with no client pack, client version or platform.
  const publication = { id: "pub-1", buildId: "build-1", version: "0.3.0", state: "published", source: { kind: "exported-game", format: "summer-bundle" }, executionMode: "hosted", targetPlatforms: [], createdAt: "2026-11-12T10:00:00Z" };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, headers, body });
    if (method === "GET" && url === GAME) return json(200, { id: "game-1", name: "Star Weavers" });
    if (method === "GET" && url === `${GAME}/revisions?limit=20`) return json(200, { items: [page] });
    if (method === "GET" && url === `${GAME}/review`) return json(200, { gameId: "game-1", outcome: "not_live", takenDown: false, message: "" });
    if (method === "GET" && url === `${GAME}/build-publications`) return json(200, { items: [publication] });
    if (method === "GET" && url === `${GAME}/build-publications/pub-1`) return json(200, publication);
    if (method === "GET" && url === `${GAME}/store/versions`) return json(200, { items: [] });
    if (method === "GET" && url === ENV) return json(200, environment);
    if (method === "GET" && url.startsWith(`${ENV}/releases/`)) {
      const release = releases[url.slice(`${ENV}/releases/`.length)];
      return release ? json(200, release) : json(404, { error: { code: "not_found" } });
    }
    if (method === "GET" && url === BUILD) return json(200, { id: "build-1", gameId: "game-1", version: "0.3.0", status: "ready", executionMode: "hosted", targetPlatforms: [], manifest: { protocolVersion: "1.0.0", serverKind: "program" } });
    if (method === "GET" && url.startsWith(`${BUILD}/client-packages/`)) {
      const id = url.slice(`${BUILD}/client-packages/`.length);
      const client = options.clients?.[id];
      return client ? json(200, { id, gameId: "game-1", buildId: "build-1", kind: "program", version: "v1.0.0", ...client }) : json(404, { error: { code: "not_found" } });
    }
    if (method === "POST" && url === `${ENV}/release-drafts`) return json(200, { id: "draft-1", revision: 1, gameId: "game-1", baseEnvironmentRevision: 7, targets: body.targets });
    if (method === "POST" && url === `${ENV}/release-drafts/draft-1:publish`) {
      if (options.release) return json(options.release.status, { error: { code: options.release.code, message: options.release.message } });
      const targets = calls.find((call) => call.method === "POST" && call.url === `${ENV}/release-drafts`)!.body.targets as Record<string, { buildId: string; qualificationId: string }>;
      releases["rel-1"] = { id: "rel-1", status: "active", server: { buildId: "build-1" }, targets: Object.entries(targets).filter(([name]) => name !== "server").map(([name, target]) => ({ target: name, buildId: target.buildId, qualificationId: target.qualificationId })) };
      environment.activeReleaseId = "rel-1";
      environment.desiredReleaseId = "rel-1";
      return json(202, { releaseId: "rel-1", operationId: "op-release", state: "pending", targets, droppedTargets: [], notUsedTargets: [] });
    }
    if (method === "POST" && url === `${GAME}/revisions/rev-1:publish`) {
      page.state = "PUBLISHED";
      return json(202, { publicationId: "gp-1", state: "ACTIVATED" });
    }
    return json(404, { error: { code: "not_found" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

let root = "";
const savedGateway = process.env.SUMMER_GATEWAY_URL;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-go-live-program-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_GATEWAY_URL = GATEWAY;
});
afterEach(async () => {
  if (savedGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = savedGateway;
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

function deps(fetch: typeof globalThis.fetch): Partial<PublishBuildDependencies> {
  let clock = 0;
  return { fetch, now: () => clock, sleep: async (ms) => void (clock += ms), token: async () => "oauth-access-token" };
}

/** This computer uploaded these clients to the Build (what summer_publish_build with buildId records). */
async function uploaded(clients: Record<string, string>): Promise<void> {
  for (const [platform, clientPackageId] of Object.entries(clients)) {
    await recordBuildClient("game-1", "build-1", platform, { clientPackageId, clientVersion: "v1.0.0", sha256: `sha256:${"a".repeat(64)}`, recordedAt: "2026-11-12T10:05:00Z" });
  }
}

const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");
const admitted = (platform: string, qualificationId: string): Client => ({ platform, state: "uploaded", qualificationId });
const three = { "client-mac": admitted("macos", "qual-mac"), "client-win": admitted("windows", "qual-win"), "client-web": admitted("web", "qual-web") };

describe("goLive: a Build whose server is a program", () => {
  it("is blocked, with what to upload, while the Build has no client", async () => {
    const store = fakeStore();
    for (const confirm of [false, true]) {
      const result = await goLive({ gameId: "game-1", confirm, face: "mcp" }, deps(store.fetch));
      expect(result).toMatchObject({ status: "blocked", build: { publicationId: "pub-1", serverKind: "program", clients: [] }, failures: [{ field: "build", code: "client_required" }] });
      const fix = String((result.failures as Array<Record<string, unknown>>)[0]!.fix);
      expect(fix).toContain("buildId build-1");
      expect(fix).toMatch(/platform macos, windows or web/);
    }
    expect(writes(store.calls)).toEqual([]);
  });

  it("shows the Build and each admitted client, and changes nothing until confirmed", async () => {
    await uploaded({ macos: "client-mac", windows: "client-win", web: "client-web" });
    const store = fakeStore({ clients: three });
    const result = await goLive({ gameId: "game-1", face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({
      status: "confirmation_required",
      page: { revisionId: "rev-1", state: "DRAFT", live: false },
      build: {
        publicationId: "pub-1",
        version: "0.3.0",
        serverKind: "program",
        checksState: "passed",
        checks: [{ platform: "macos", state: "passed" }, { platform: "windows", state: "passed" }, { platform: "web", state: "passed" }],
        clients: [
          { platform: "macos", clientPackageId: "client-mac", qualificationId: "qual-mac", version: "v1.0.0" },
          { platform: "windows", clientPackageId: "client-win", qualificationId: "qual-win", version: "v1.0.0" },
          { platform: "web", clientPackageId: "client-web", qualificationId: "qual-web", version: "v1.0.0" },
        ],
        livePlatforms: [],
      },
    });
    expect(writes(store.calls)).toEqual([]);
  });

  it("releases the server with its macOS, Windows and web clients, publishes the page and reports live", async () => {
    await uploaded({ macos: "client-mac", windows: "client-win", web: "client-web" });
    const store = fakeStore({ clients: three });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));

    // Each member is a client of this very Build, selected by its upload and the qualification it earned.
    const draft = store.calls.find((call) => call.method === "POST" && call.url === `${ENV}/release-drafts`)!;
    expect(draft.body.targets).toEqual({
      server: { buildId: "build-1", qualificationId: "" },
      macos: { buildId: "build-1", uploadId: "client-mac", qualificationId: "qual-mac" },
      windows: { buildId: "build-1", uploadId: "client-win", qualificationId: "qual-win" },
      web: { buildId: "build-1", uploadId: "client-web", qualificationId: "qual-web" },
    });
    const release = store.calls.find((call) => call.url === `${ENV}/release-drafts/draft-1:publish`)!;
    expect({ ...release.body, targets: [...release.body.targets].sort() }).toEqual({ targets: ["macos", "server", "web", "windows"], replaceTargets: true });

    expect(result).toMatchObject({ status: "live", page: { state: "PUBLISHED", live: true }, build: { serverKind: "program", livePlatforms: ["macos", "windows", "web"] } });
    // Three writes and no other: who can find the store page is never touched, so a Private page stays Private.
    expect(writes(store.calls).map((call) => `${call.method} ${call.url}`)).toEqual([`POST ${ENV}/release-drafts`, `POST ${ENV}/release-drafts/draft-1:publish`, `POST ${GAME}/revisions/rev-1:publish`]);
  });

  it("releases the admitted clients and reports a rejected one with the store's own code and message", async () => {
    await uploaded({ macos: "client-mac", web: "client-web" });
    const message = "the archive does not hold index.html at its root";
    const store = fakeStore({ clients: { "client-mac": admitted("macos", "qual-mac"), "client-web": { platform: "web", state: "rejected", verificationError: "client_entry_missing", verificationMessage: message } } });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    const draft = store.calls.find((call) => call.method === "POST" && call.url === `${ENV}/release-drafts`)!;
    expect(Object.keys(draft.body.targets).sort()).toEqual(["macos", "server"]);
    expect(result).toMatchObject({ status: "live", build: { livePlatforms: ["macos"] }, notReleased: [{ platform: "web", state: "failed", code: "client_entry_missing", message, owner: "creator" }] });
  });

  it("waits, and asks nothing of the store, while Summer still reads a client", async () => {
    await uploaded({ macos: "client-mac" });
    const store = fakeStore({ clients: { "client-mac": { platform: "macos", state: "verifying" } } });
    const result = await goLive({ gameId: "game-1", confirm: true, waitSeconds: 30, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "waiting", waitingOn: "automated_checks", build: { checksState: "checking", checks: [{ platform: "macos", state: "checking" }] } });
    expect(writes(store.calls)).toEqual([]);
  });

  it("is blocked when no client passed, naming each failure", async () => {
    await uploaded({ windows: "client-win" });
    const store = fakeStore({ clients: { "client-win": { platform: "windows", state: "rejected", verificationError: "client_architecture_unsupported", verificationMessage: "Game.exe is a 32-bit executable" } } });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "blocked", failures: [{ field: "build", code: "no_platform_passed" }, { field: "build windows", code: "client_architecture_unsupported", message: "Game.exe is a 32-bit executable" }] });
    expect(String((result.failures as Array<Record<string, unknown>>)[0]!.fix)).toContain("with buildId");
    expect(writes(store.calls)).toEqual([]);
  });

  it("reports live from what players have when the clients were uploaded from another computer", async () => {
    const store = fakeStore({ live: [{ target: "macos", qualificationId: "qual-mac" }, { target: "web", qualificationId: "qual-web" }] });
    const result = await goLive({ gameId: "game-1", face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "live", build: { serverKind: "program", livePlatforms: ["macos", "web"] } });
    expect(writes(store.calls)).toEqual([]);
  });

  it("releases a newer client of the same Build, keeping the other platform's live client", async () => {
    await uploaded({ macos: "client-mac-2" });
    const store = fakeStore({
      clients: { "client-mac-2": admitted("macos", "qual-mac-2") },
      live: [{ target: "macos", qualificationId: "qual-mac" }, { target: "windows", qualificationId: "qual-win" }],
    });
    const plan = await goLive({ gameId: "game-1", face: "mcp" }, deps(store.fetch));
    // Players still have the older macOS client: this one is not live yet.
    expect(plan).toMatchObject({ status: "confirmation_required", build: { livePlatforms: ["windows"] } });

    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    const draft = store.calls.find((call) => call.method === "POST" && call.url === `${ENV}/release-drafts`)!;
    expect(draft.body.targets).toEqual({
      server: { buildId: "build-1", qualificationId: "" },
      macos: { buildId: "build-1", uploadId: "client-mac-2", qualificationId: "qual-mac-2" },
      windows: { buildId: "build-1", qualificationId: "qual-win" },
    });
    expect(result).toMatchObject({ status: "live", build: { livePlatforms: ["macos", "windows"] } });
  });

  it("passes the store's refusal of a browser client for a game with a price through", async () => {
    await uploaded({ macos: "client-mac", web: "client-web" });
    const message = "this game has a price, so it takes no browser build yet";
    const store = fakeStore({ clients: three, release: { status: 409, code: "web_client_game_priced", message } });
    let error: unknown;
    try {
      await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BuildToolError);
    expect((error as BuildToolError).code).toBe("web_client_game_priced");
    expect((error as BuildToolError).message).toContain(message);
    // The page is not published on a refused release.
    expect(writes(store.calls).some((call) => call.url.endsWith("/revisions/rev-1:publish"))).toBe(false);
  });
});
