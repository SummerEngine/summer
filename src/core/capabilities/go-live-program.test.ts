import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSummerDir, setSummerDirForTests } from "../store.js";
import { goLive } from "./go-live.js";
import type { PublishBuildDependencies } from "./publish-build.js";
import { BuildToolError } from "./summer-bundle.js";

const GATEWAY = "https://gateway.test";
const STORE = `${GATEWAY}/api/creator-store`;
const GAME = `${STORE}/games/game-1`;
const ENV = `${GAME}/environments/env_production`;
const DRAFTS = `${ENV}/release-drafts`;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

type Client = { platform: string; state: string; kind?: string; qualificationId?: string; verificationError?: string; verificationMessage?: string };
type Member = { target: string; buildId: string; qualificationId: string };

/**
 * A fake creator store for a game not made with Summer Engine: one store page
 * revision, published Builds whose server is a program (their publications
 * have no client pack, client version or platform), each Build's clients by
 * id, the production environment and Summer's review.
 *
 * It holds what the store holds a release to: a client is read only under its
 * own Build; a draft and its publish are idempotent on their key, and the same
 * key with another body is refused; a complete publish makes the release
 * exactly the members it names; a browser client is refused for a game with a
 * price, and a client Summer withdrew is refused although its read says
 * admitted.
 */
function fakeStore(options: {
  /** Each Build's clients as the store holds them, by client id. */
  clients?: Record<string, Record<string, Client>>;
  /** What players have now: the live release's members. */
  live?: Member[];
  /** The game has a price: a release with a browser client is refused whole. */
  priced?: boolean;
  /** Qualifications Summer withdrew: a release that names one is refused whole. */
  revoked?: string[];
  /** public or private, as the game read carries it; absent, the store does not say. */
  visibility?: string;
  /** The newest publication's Build (default build-1); build-2 is a second Build of the game. */
  newest?: "build-1" | "build-2";
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
  const releases: Record<string, Record<string, any>> = options.live ? { "rel-0": { id: "rel-0", status: "active", targets: options.live, server: { buildId: options.live[0]?.buildId } } } : {};
  // A program publication: exported-game, hosted, published, with no client pack, client version or platform.
  const publication = (id: string, buildId: string, createdAt: string) => ({ id, buildId, version: buildId === "build-1" ? "0.3.0" : "0.4.0", state: "published", source: { kind: "exported-game", format: "summer-bundle" }, executionMode: "hosted", targetPlatforms: [], createdAt });
  const publications = [publication("pub-1", "build-1", "2026-11-12T10:00:00Z"), ...(options.newest === "build-2" ? [publication("pub-2", "build-2", "2026-11-13T10:00:00Z")] : [])];
  const drafts = new Map<string, { id: string; body: string }>();
  const published = new Map<string, { body: string; answer: Record<string, unknown> }>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const conflict = () => json(409, { error: { code: "idempotency_conflict", message: "idempotency key was reused" } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, headers, body });
    if (method === "GET" && url === GAME) return json(200, { id: "game-1", name: "Star Weavers", ...(options.visibility ? { storeVisibility: options.visibility } : {}) });
    if (method === "GET" && url === `${GAME}/revisions?limit=20`) return json(200, { items: [page] });
    if (method === "GET" && url === `${GAME}/review`) return json(200, { gameId: "game-1", outcome: "not_live", takenDown: false, message: "" });
    if (method === "GET" && url === `${GAME}/build-publications`) return json(200, { items: publications });
    if (method === "GET" && url.startsWith(`${GAME}/build-publications/`)) {
      const found = publications.find((item) => item.id === url.slice(`${GAME}/build-publications/`.length));
      return found ? json(200, found) : json(404, { error: { code: "not_found" } });
    }
    if (method === "GET" && url === `${GAME}/store/versions`) return json(200, { items: [] });
    if (method === "GET" && url === ENV) return json(200, environment);
    if (method === "GET" && url.startsWith(`${ENV}/releases/`)) {
      const release = releases[url.slice(`${ENV}/releases/`.length)];
      return release ? json(200, release) : json(404, { error: { code: "not_found" } });
    }
    const build = /\/builds\/(build-\d)(?:\/client-packages\/(.+))?$/.exec(url);
    if (method === "GET" && build && !build[2]) return json(200, { id: build[1], gameId: "game-1", status: "ready", executionMode: "hosted", targetPlatforms: [], manifest: { protocolVersion: "1.0.0", serverKind: "program" } });
    if (method === "GET" && build && build[2]) {
      // A client is found only under the Build it was uploaded to.
      const client = options.clients?.[build[1]!]?.[build[2]];
      return client ? json(200, { id: build[2], gameId: "game-1", buildId: build[1], kind: "program", version: "v1.0.0", ...client }) : json(404, { error: { code: "not_found" } });
    }
    if (method === "POST" && url === DRAFTS) {
      const key = headers["idempotency-key"] ?? "";
      const known = drafts.get(key);
      if (known && known.body !== JSON.stringify(body)) return conflict();
      const id = known?.id ?? `draft-${drafts.size + 1}`;
      drafts.set(key, { id, body: JSON.stringify(body) });
      return json(200, { id, revision: 1, gameId: "game-1", baseEnvironmentRevision: environment.revision, targets: body.targets });
    }
    const publish = /\/release-drafts\/(draft-\d+):publish$/.exec(url);
    if (method === "POST" && publish) {
      const key = headers["idempotency-key"] ?? "";
      const replay = published.get(key);
      if (replay) return replay.body === JSON.stringify(body) ? json(202, replay.answer) : conflict();
      const draft = [...drafts.values()].find((item) => item.id === publish[1])!;
      const targets = JSON.parse(draft.body).targets as Record<string, { buildId: string; uploadId?: string; qualificationId: string }>;
      const named = (body.targets as string[]).filter((name) => name !== "server");
      if (options.priced && named.includes("web")) return json(409, { error: { code: "web_client_game_priced", message: "this game has a price, so it takes no browser build yet" } });
      const withdrawn = named.find((name) => options.revoked?.includes(targets[name]!.qualificationId));
      if (withdrawn) return json(409, { error: { code: "draft_not_ready", message: `the selected ${withdrawn} client still needs verification for this Build` } });
      // A complete publish (replaceTargets) makes the release exactly the members named.
      const id = `rel-${Object.keys(releases).length + 1}`;
      releases[id] = { id, status: "active", server: { buildId: targets.server!.buildId }, targets: (body.replaceTargets ? named : Object.keys(targets).filter((name) => name !== "server")).map((name) => ({ target: name, buildId: targets[name]!.buildId, qualificationId: targets[name]!.qualificationId })) };
      environment.activeReleaseId = id;
      environment.desiredReleaseId = id;
      environment.revision += 1;
      const answer = { releaseId: id, operationId: "op-release", state: "pending", targets, droppedTargets: [], notUsedTargets: [] };
      published.set(key, { body: JSON.stringify(body), answer });
      return json(202, answer);
    }
    if (method === "POST" && url === `${GAME}/revisions/rev-1:publish`) {
      page.state = "PUBLISHED";
      return json(202, { publicationId: "gp-1", state: "ACTIVATED" });
    }
    return json(404, { error: { code: "not_found" } });
  }) as typeof globalThis.fetch;
  /** What players have now, per platform. */
  const players = () => Object.fromEntries(((releases[environment.activeReleaseId]?.targets ?? []) as Member[]).map((member) => [member.target, member.qualificationId]));
  return { fetch, calls, players };
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

const writes = (calls: Call[]) => calls.filter((call) => call.method !== "GET");
const draftsOf = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.url === DRAFTS);
const admitted = (platform: string, qualificationId: string): Client => ({ platform, state: "uploaded", qualificationId });
const live = (target: string, qualificationId: string, buildId = "build-1"): Member => ({ target, buildId, qualificationId });
const failuresOf = (result: Record<string, unknown>) => result.failures as Array<Record<string, unknown>>;
const three = { "client-mac": admitted("macos", "qual-mac"), "client-win": admitted("windows", "qual-win"), "client-web": admitted("web", "qual-web") };

describe("goLive: a Build whose server is a program", () => {
  it("is blocked, with what to upload and how to name it, while no client is named or live", async () => {
    const store = fakeStore();
    for (const confirm of [false, true]) {
      const result = await goLive({ gameId: "game-1", confirm, face: "mcp" }, deps(store.fetch));
      expect(result).toMatchObject({ status: "blocked", build: { publicationId: "pub-1", buildId: "build-1", serverKind: "program", willBeLive: [], removed: [] }, failures: [{ field: "build", code: "client_required" }] });
      const fix = String(failuresOf(result)[0]!.fix);
      expect(fix).toContain("buildId build-1");
      expect(fix).toMatch(/platform macos, windows or web/);
      expect(fix).toContain("clients");
    }
    expect(writes(store.calls)).toEqual([]);
  });

  it("shows exactly what players will have per platform, and changes nothing until confirmed", async () => {
    const store = fakeStore({ clients: { "build-1": three } });
    const result = await goLive({ gameId: "game-1", clients: ["client-mac", "client-win", "client-web"], face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({
      status: "confirmation_required",
      page: { revisionId: "rev-1", state: "DRAFT", live: false },
      build: {
        publicationId: "pub-1",
        version: "0.3.0",
        serverKind: "program",
        checksState: "passed",
        willBeLive: [
          { platform: "macos", from: "clients", clientPackageId: "client-mac", qualificationId: "qual-mac", version: "v1.0.0" },
          { platform: "windows", from: "clients", clientPackageId: "client-win", qualificationId: "qual-win", version: "v1.0.0" },
          { platform: "web", from: "clients", clientPackageId: "client-web", qualificationId: "qual-web", version: "v1.0.0" },
        ],
        removed: [],
        livePlatforms: [],
      },
    });
    expect(String(result.next)).toContain("the same clients and remove");
    expect(writes(store.calls)).toEqual([]);
  });

  it("releases the server with the clients named, publishes the page and reports live", async () => {
    const store = fakeStore({ clients: { "build-1": three } });
    const result = await goLive({ gameId: "game-1", clients: ["client-mac", "client-win", "client-web"], confirm: true, face: "mcp" }, deps(store.fetch));

    // Each member is a client of this very Build, selected by its upload and the qualification it earned.
    expect(draftsOf(store.calls)[0]!.body.targets).toEqual({
      server: { buildId: "build-1", qualificationId: "" },
      macos: { buildId: "build-1", uploadId: "client-mac", qualificationId: "qual-mac" },
      windows: { buildId: "build-1", uploadId: "client-win", qualificationId: "qual-win" },
      web: { buildId: "build-1", uploadId: "client-web", qualificationId: "qual-web" },
    });
    expect(store.players()).toEqual({ macos: "qual-mac", windows: "qual-win", web: "qual-web" });
    expect(result).toMatchObject({ status: "live", page: { state: "PUBLISHED", live: true }, build: { serverKind: "program", livePlatforms: ["macos", "windows", "web"] } });
    // Three writes and no other: who can find the store page is never touched.
    expect(writes(store.calls).map((call) => `${call.method} ${call.url}`)).toEqual([`POST ${DRAFTS}`, `POST ${DRAFTS}/draft-1:publish`, `POST ${GAME}/revisions/rev-1:publish`]);
    // The plan came from the call and the store: nothing about clients is kept on this computer.
    expect((await readdir(getSummerDir())).sort()).toEqual(["creator-audit.jsonl"]);
  });

  it("never takes a live platform away because its new client was rejected: the call is blocked, and Windows stays as it was", async () => {
    // macOS and Windows are live. The new Windows archive was rejected; the new macOS one was admitted.
    const options = {
      clients: { "build-1": { "client-mac-2": admitted("macos", "qual-mac-2"), "client-win-2": { platform: "windows", state: "rejected", verificationError: "client_architecture_unsupported", verificationMessage: "Game.exe is a 32-bit executable" } } },
      live: [live("macos", "qual-mac"), live("windows", "qual-win")],
    };

    // Naming both: refused by name before any write, with the store's own code and message.
    const both = fakeStore(options);
    const blocked = await goLive({ gameId: "game-1", clients: ["client-mac-2", "client-win-2"], confirm: true, face: "mcp" }, deps(both.fetch));
    expect(blocked).toMatchObject({ status: "blocked", failures: [{ field: "client client-win-2", platform: "windows", code: "client_architecture_unsupported", message: "Game.exe is a 32-bit executable", owner: "creator" }] });
    expect(writes(both.calls)).toEqual([]);
    expect(both.players()).toEqual({ macos: "qual-mac", windows: "qual-win" });

    // Naming only the admitted one: the new macOS client goes out, and Windows players keep what they have.
    const one = fakeStore(options);
    const preview = await goLive({ gameId: "game-1", clients: ["client-mac-2"], face: "mcp" }, deps(one.fetch));
    expect(preview).toMatchObject({
      status: "confirmation_required",
      build: {
        willBeLive: [
          { platform: "macos", from: "clients", clientPackageId: "client-mac-2", qualificationId: "qual-mac-2" },
          { platform: "windows", from: "live", clientPackageId: null, qualificationId: "qual-win" },
        ],
        removed: [],
        livePlatforms: ["windows"],
      },
    });
    const result = await goLive({ gameId: "game-1", clients: ["client-mac-2"], confirm: true, face: "mcp" }, deps(one.fetch));
    expect(draftsOf(one.calls)[0]!.body.targets).toEqual({
      server: { buildId: "build-1", qualificationId: "" },
      macos: { buildId: "build-1", uploadId: "client-mac-2", qualificationId: "qual-mac-2" },
      windows: { buildId: "build-1", qualificationId: "qual-win" },
    });
    expect(one.players()).toEqual({ macos: "qual-mac-2", windows: "qual-win" });
    expect(result).toMatchObject({ status: "live", build: { livePlatforms: ["macos", "windows"], removed: [] } });
  });

  it("is blocked, naming the platform, when a new Build would leave a live platform without a client", async () => {
    // Players have macOS and Windows from build-1. build-2 is the newest; only its macOS client is named.
    const store = fakeStore({ newest: "build-2", clients: { "build-2": { "client-mac-b2": admitted("macos", "qual-mac-b2") } }, live: [live("macos", "qual-mac"), live("windows", "qual-win")] });
    for (const confirm of [false, true]) {
      const result = await goLive({ gameId: "game-1", clients: ["client-mac-b2"], confirm, face: "mcp" }, deps(store.fetch));
      expect(result).toMatchObject({ status: "blocked", build: { publicationId: "pub-2", buildId: "build-2" }, failures: [{ field: "platform windows", code: "platform_would_be_removed" }] });
      const fix = String(failuresOf(result)[0]!.fix);
      expect(fix).toContain("Windows is live now");
      expect(fix).toContain("buildId build-2, platform windows");
      expect(fix).toContain("name windows in remove");
    }
    expect(writes(store.calls)).toEqual([]);
    expect(store.players()).toEqual({ macos: "qual-mac", windows: "qual-win" });
  });

  it("takes a platform out only when remove names it, and says so before and after", async () => {
    const store = fakeStore({ newest: "build-2", clients: { "build-2": { "client-mac-b2": admitted("macos", "qual-mac-b2") } }, live: [live("macos", "qual-mac"), live("windows", "qual-win")] });
    const input = { gameId: "game-1", clients: ["client-mac-b2"], remove: ["windows"], face: "mcp" as const };
    const preview = await goLive(input, deps(store.fetch));
    expect(preview).toMatchObject({ status: "confirmation_required", build: { willBeLive: [{ platform: "macos", from: "clients", clientPackageId: "client-mac-b2" }], removed: ["windows"] } });
    expect(writes(store.calls)).toEqual([]);

    const result = await goLive({ ...input, confirm: true }, deps(store.fetch));
    expect(draftsOf(store.calls)[0]!.body.targets).toEqual({ server: { buildId: "build-2", qualificationId: "" }, macos: { buildId: "build-2", uploadId: "client-mac-b2", qualificationId: "qual-mac-b2" } });
    expect(store.players()).toEqual({ macos: "qual-mac-b2" });
    expect(result).toMatchObject({ status: "live", build: { livePlatforms: ["macos"], removed: ["windows"] } });
    expect(String(result.next)).toContain("Taken out as asked: Windows.");
  });

  it("takes a live platform of the same Build out when remove names it, with no client named", async () => {
    const store = fakeStore({ live: [live("macos", "qual-mac"), live("web", "qual-web")] });
    const result = await goLive({ gameId: "game-1", remove: ["web"], confirm: true, face: "mcp" }, deps(store.fetch));
    expect(draftsOf(store.calls)[0]!.body.targets).toEqual({ server: { buildId: "build-1", qualificationId: "" }, macos: { buildId: "build-1", qualificationId: "qual-mac" } });
    expect(store.players()).toEqual({ macos: "qual-mac" });
    expect(result).toMatchObject({ status: "live", build: { removed: ["web"] } });
  });

  it("refuses, by name and before any write, a client of another Build, of another game, or an id the store does not know", async () => {
    // client-mac-b2 exists, under build-2. The newest Build, and so the one released, is build-1.
    const store = fakeStore({ clients: { "build-1": { "client-mac": admitted("macos", "qual-mac") }, "build-2": { "client-mac-b2": admitted("macos", "qual-mac-b2") } }, live: [live("macos", "qual-mac")] });
    for (const id of ["client-mac-b2", "client-of-another-game", "nonsense"]) {
      const result = await goLive({ gameId: "game-1", clients: [id], confirm: true, face: "mcp" }, deps(store.fetch));
      // Not "live" on what players have already: what the call asked for was refused.
      expect(result).toMatchObject({ status: "blocked", failures: [{ field: `client ${id}`, code: "client_not_found" }] });
      expect(String(failuresOf(result)[0]!.fix)).toContain(`"${id}" is not a client of Build build-1 of this game`);
    }
    expect(writes(store.calls)).toEqual([]);
  });

  it("refuses two clients for one platform, and a platform named both in clients and in remove", async () => {
    const store = fakeStore({ clients: { "build-1": { "client-mac": admitted("macos", "qual-mac"), "client-mac-2": admitted("macos", "qual-mac-2") } } });
    const twice = await goLive({ gameId: "game-1", clients: ["client-mac", "client-mac-2"], confirm: true, face: "mcp" }, deps(store.fetch));
    expect(twice).toMatchObject({ status: "blocked", failures: [{ field: "client client-mac-2", code: "client_platform_repeated" }] });
    const both = await goLive({ gameId: "game-1", clients: ["client-mac"], remove: ["macos"], confirm: true, face: "mcp" }, deps(store.fetch));
    expect(both).toMatchObject({ status: "blocked", failures: [{ field: "platform macos", code: "remove_conflicts_with_client" }] });
    expect(writes(store.calls)).toEqual([]);
  });

  it("waits, and asks nothing of the store, while Summer still reads a named client", async () => {
    const store = fakeStore({ clients: { "build-1": { "client-mac": { platform: "macos", state: "verifying" } } } });
    const result = await goLive({ gameId: "game-1", clients: ["client-mac"], confirm: true, waitSeconds: 30, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "waiting", waitingOn: "automated_checks", build: { checksState: "checking", checks: [{ platform: "macos", state: "checking" }] } });
    expect(writes(store.calls)).toEqual([]);
  });

  it("reports live from what players have, with no client named", async () => {
    const store = fakeStore({ live: [live("macos", "qual-mac"), live("web", "qual-web")] });
    const result = await goLive({ gameId: "game-1", face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({
      status: "live",
      build: { serverKind: "program", livePlatforms: ["macos", "web"], willBeLive: [{ platform: "macos", from: "live", qualificationId: "qual-mac" }, { platform: "web", from: "live", qualificationId: "qual-web" }] },
    });
    expect(writes(store.calls)).toEqual([]);
  });

  it("passes the store's refusal of a browser client for a game with a price through, and releases the rest when asked again without it", async () => {
    const store = fakeStore({ priced: true, clients: { "build-1": three } });
    const refused = await goLive({ gameId: "game-1", clients: ["client-mac", "client-web"], confirm: true, face: "mcp" }, deps(store.fetch));
    expect(refused).toMatchObject({ status: "blocked", failures: [{ field: "release", code: "web_client_game_priced", message: "this game has a price, so it takes no browser build yet" }] });
    expect(String(failuresOf(refused)[0]!.fix)).toContain("without the web client");
    // Nothing was released, and the page was not published on a refused release.
    expect(store.players()).toEqual({});
    expect(writes(store.calls).some((call) => call.url.endsWith("/revisions/rev-1:publish"))).toBe(false);

    // Another selection after a refused release is another request to the store, not a replay of the refused one:
    // this store answers idempotency_conflict to the same key with another body.
    const result = await goLive({ gameId: "game-1", clients: ["client-mac"], confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "live", build: { livePlatforms: ["macos"] } });
    expect(store.players()).toEqual({ macos: "qual-mac" });
    const keys = draftsOf(store.calls).map((call) => call.headers["idempotency-key"]);
    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("asks nothing twice when the same selection is confirmed again", async () => {
    const store = fakeStore({ priced: true, clients: { "build-1": three } });
    const input = { gameId: "game-1", clients: ["client-web", "client-mac"], confirm: true, face: "mcp" as const };
    await goLive(input, deps(store.fetch));
    await goLive({ ...input, clients: ["client-mac", "client-web"] }, deps(store.fetch));
    // The same members, in any order, are the same request.
    const keys = draftsOf(store.calls).map((call) => call.headers["idempotency-key"]);
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("reports a client the store will not release although its read says admitted, with the store's own words", async () => {
    const store = fakeStore({ revoked: ["qual-win"], clients: { "build-1": three } });
    const result = await goLive({ gameId: "game-1", clients: ["client-mac", "client-win"], confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "blocked", failures: [{ field: "release", code: "draft_not_ready", message: "the selected windows client still needs verification for this Build" }] });
    expect(String(failuresOf(result)[0]!.fix)).toContain("call summer_go_live again without it");
    expect(store.players()).toEqual({});
  });

  it("says the page is Private when it is, and never that players at large get it", async () => {
    const privately = fakeStore({ visibility: "private", clients: { "build-1": three } });
    const result = await goLive({ gameId: "game-1", clients: ["client-mac"], confirm: true, face: "mcp" }, deps(privately.fetch));
    expect(result).toMatchObject({ status: "live", game: { storeVisibility: "private" } });
    expect(String(result.next)).toContain("The store page is Private");
    expect(String(result.next)).not.toMatch(/players get it now/i);

    // When the store does not say, the sentence is true for both.
    const untold = fakeStore({ clients: { "build-1": three } });
    const neutral = await goLive({ gameId: "game-1", clients: ["client-mac"], confirm: true, face: "mcp" }, deps(untold.fetch));
    expect(String(neutral.next)).toContain("everyone who can see the store page gets it now");
  });

  it("does not take clients or remove for a Build with a Summer Engine server", async () => {
    // No Build of this game has a program server: the publication names a client version, as every Engine export does.
    const calls: string[] = [];
    const engine = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push(`${init.method ?? "GET"} ${url}`);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      const publication = { id: "pub-9", buildId: "build-9", clientVersion: "v1.0.0", state: "preview_ready", source: { kind: "exported-game" }, createdAt: "2026-11-12T10:00:00Z", clientPackage: { id: "pack-9", state: "uploaded", verifications: [{ platform: "ios", state: "ready", qualificationId: "q-ios" }] } };
      if (url === GAME) return json({ id: "game-1", name: "Star Weavers" });
      if (url === `${GAME}/revisions?limit=20`) return json({ items: [] });
      if (url === `${GAME}/build-publications`) return json({ items: [publication] });
      if (url === `${GAME}/build-publications/pub-9`) return json(publication);
      return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    let error: unknown;
    try {
      await goLive({ gameId: "game-1", clients: ["client-mac"], confirm: true, face: "mcp" }, deps(engine));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BuildToolError);
    expect((error as BuildToolError).code).toBe("clients_not_applicable");
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  });
});
