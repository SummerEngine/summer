import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSummerDirForTests } from "../store.js";
import { goLive } from "./go-live.js";
import type { PublishBuildDependencies } from "./publish-build.js";

const GATEWAY = "https://gateway.test";
const STORE = `${GATEWAY}/api/creator-store`;
const GAME = `${STORE}/games/game-1`;
const ENV = `${GAME}/environments/env_production`;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

/**
 * A fake creator store with the platform's state: one store page revision,
 * one exported Build with per-platform checks, the production environment
 * and Summer's review. Publishing moves the state the way the platform does,
 * or holds it as the options say.
 */
function fakeStore(options: {
  page?: Record<string, unknown>;
  /** The deprecated GET games/{g}/approval; absent answers 404, as once the platform deletes it. A number answers that error status. */
  approval?: Record<string, unknown> | number;
  /** Summer's review after live (GET games/{g}/review); absent answers 404, as a platform before it. */
  review?: Record<string, unknown>;
  hosted?: boolean;
  checks?: Array<Record<string, unknown>>;
  buildStatus?: string;
  /** The platform holds the launch: the page stays SUBMITTED and no release activates. */
  hold?: boolean;
  pagePublish?: { status: number; code: string; missing?: string[]; message?: string };
  live?: boolean;
  noBuild?: boolean;
  /** Client platforms the release leaves out (DroppedReleaseTarget), on the publish answer and the release read. */
  drop?: Array<Record<string, unknown>>;
  /** The platform refuses the release: "now" answers the publish with 409, "rollout" fails the deploy afterwards. */
  serverOnly?: "now" | "rollout";
  /** Newer clients the release does not use (notUsedTargets): those platforms keep a live client of another Build. */
  notUsed?: Array<Record<string, unknown>>;
  /** The platform's message with that refusal; absent, it sends none. */
  serverOnlyMessage?: string;
} = {}) {
  const calls: Call[] = [];
  const page: Record<string, any> = {
    revisionId: "rev-1",
    sequence: 1,
    state: "DRAFT",
    etagRevision: 4,
    presentation: { name: "Star Weavers", description: "Weave stars into constellations with friends." },
    supportedPlatforms: ["ios", "android", "web"],
    contentRating: "everyone",
    contentDescriptors: [],
    ...options.page,
  };
  let buildStatus = options.buildStatus ?? "preview_ready";
  const environment: Record<string, any> = { id: "env_production", kind: "production", status: "active", revision: 7, activeReleaseId: options.live ? "rel-1" : null, desiredReleaseId: options.live ? "rel-1" : null };
  let release: Record<string, any> | null = options.live
    ? { id: "rel-1", status: "active", targets: [{ target: "ios", buildId: "build-1", qualificationId: "q-ios" }], ...(options.hosted ? { server: { buildId: "build-1" } } : {}) }
    : null;
  if (options.live) page.state = "PUBLISHED";
  const checks = options.checks ?? [{ id: "v1", platform: "ios", state: "ready", qualificationId: "q-ios" }];
  const publication = {
    id: "pub-1",
    buildId: "build-1",
    clientVersion: "v1.0.0",
    state: "preview_ready",
    source: { kind: "exported-game" },
    build: { executionMode: options.hosted ? "hosted" : "standalone" },
    createdAt: "2026-10-19T10:00:00Z",
    clientPackage: { id: "pack-1", state: "uploaded", verifications: checks },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, headers, body });
    if (method === "GET" && url === GAME) return json(200, { id: "game-1", name: "Star Weavers" });
    if (method === "GET" && url === `${GAME}/revisions?limit=20`) return json(200, { items: [page] });
    if (method === "GET" && url === `${GAME}/approval`) {
      if (options.approval === undefined) return json(404, { error: { code: "not_found" } });
      return typeof options.approval === "number" ? json(options.approval, { error: { code: "internal" } }) : json(200, options.approval);
    }
    if (method === "GET" && url === `${GAME}/review`) return options.review ? json(200, options.review) : json(404, { error: { code: "not_found" } });
    if (method === "GET" && url === `${GAME}/build-publications`) return json(200, { items: options.noBuild ? [] : [{ ...publication, clientPackage: undefined }] });
    if (method === "GET" && url === `${GAME}/build-publications/pub-1`) return json(200, publication);
    if (method === "GET" && url === `${GAME}/store/versions`) return json(200, { items: [] });
    if (method === "GET" && url === ENV) return json(200, environment);
    if (method === "GET" && url === `${ENV}/releases/rel-1`) return release ? json(200, release) : json(404, { error: { code: "not_found" } });
    if (method === "GET" && url === `${GAME}/builds/build-1`) return json(200, { id: "build-1", status: buildStatus, executionMode: options.hosted ? "hosted" : "standalone" });
    if (method === "POST" && url === `${GAME}/build-publications/pub-1:publish`) {
      buildStatus = "ready";
      return json(202, { operationId: "op-prepare" });
    }
    if (method === "POST" && url === `${ENV}/release-drafts`) return json(200, { id: "draft-1", revision: 2, gameId: "game-1", baseEnvironmentRevision: 7, targets: body.targets });
    if (method === "POST" && url === `${ENV}/release-drafts/draft-1:publish`) {
      if (options.serverOnly === "now") return json(409, { error: { code: "playable_release_required", ...(options.serverOnlyMessage ? { message: options.serverOnlyMessage } : {}), retryable: false } });
      const dropped = options.drop ?? [];
      if (options.serverOnly === "rollout") {
        // The deploy fails: the environment forgets the desired release, which keeps its failed rollout.
        release = { id: "rel-1", status: "failed", targets: [], ...(options.drop ? { droppedTargets: dropped } : {}), rollout: { operationId: "op-release", kind: "release.deploy", state: "failed", errorCode: "playable_release_required", ...(options.serverOnlyMessage ? { message: options.serverOnlyMessage } : {}) } };
        return json(202, { releaseId: "rel-1", operationId: "op-release", state: "pending", ...(options.drop ? { droppedTargets: dropped } : {}) });
      }
      environment.desiredReleaseId = "rel-1";
      if (!options.hold) {
        environment.activeReleaseId = "rel-1";
        release = {
          id: "rel-1",
          status: "active",
          targets: Object.entries(calls.find((call) => call.url === `${ENV}/release-drafts`)!.body.targets)
            .filter(([name]) => name !== "server" && !dropped.some((drop) => drop.target === name))
            // A client the release did not use stays on the live client of the server's Build.
            .map(([name, target]: [string, any]) => ({ target: name, buildId: options.notUsed?.some((item) => item.target === name) ? "build-0" : target.buildId, qualificationId: target.qualificationId })),
          ...(options.drop ? { droppedTargets: dropped } : {}),
          ...(options.notUsed ? { notUsedTargets: options.notUsed } : {}),
        };
      }
      return json(202, { operationId: "op-release", releaseId: "rel-1", ...(options.drop ? { droppedTargets: dropped } : {}), ...(options.notUsed ? { notUsedTargets: options.notUsed } : {}) });
    }
    if (method === "POST" && url === `${GAME}/revisions/rev-1:publish`) {
      if (options.pagePublish) return json(options.pagePublish.status, { error: { code: options.pagePublish.code, message: options.pagePublish.message ?? "refused", ...(options.pagePublish.missing ? { missing: options.pagePublish.missing } : {}) } });
      page.state = options.hold ? "SUBMITTED" : "PUBLISHED";
      return json(202, { publicationId: "gp-1", state: options.hold ? "WAITING_VERIFICATION" : "ACTIVATED" });
    }
    return json(404, { error: { code: "not_found" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, page };
}

let root = "";
const savedGateway = process.env.SUMMER_GATEWAY_URL;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-go-live-test-"));
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

describe("goLive", () => {
  it("shows the plan and changes nothing until confirmed", async () => {
    const store = fakeStore();
    const result = await goLive({ gameId: "game-1", face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({
      status: "confirmation_required",
      page: { revisionId: "rev-1", state: "DRAFT", live: false },
      build: { publicationId: "pub-1", version: "v1.0.0", checksState: "passed" },
    });
    expect(writes(store.calls)).toEqual([]);
  });

  it("releases the checked Build, publishes the page and reports live", async () => {
    const store = fakeStore();
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "live", page: { state: "PUBLISHED", live: true }, build: { livePlatforms: ["ios"] } });

    const draft = store.calls.find((call) => call.url === `${ENV}/release-drafts`)!;
    expect(draft.body.targets).toEqual({ ios: { buildId: "build-1", uploadId: "pack-1", qualificationId: "q-ios" } });
    const release = store.calls.find((call) => call.url.endsWith("draft-1:publish"))!;
    expect(release.headers["x-summer-revision"]).toBe('"2"');
    expect(release.body).toEqual({ targets: ["ios"], replaceTargets: true });
    const pagePublish = store.calls.find((call) => call.url.endsWith("rev-1:publish"))!;
    expect(pagePublish.headers["x-summer-revision"]).toBe('"game-revision:rev-1:4"');
    expect(pagePublish.headers["idempotency-key"]).toMatch(/^[0-9a-f]{64}$/);
    // The Build is released before the page, so a released page has a playable release.
    const order = writes(store.calls).map((call) => call.url.split("/").pop());
    expect(order.indexOf("draft-1:publish")).toBeLessThan(order.indexOf("rev-1:publish"));
    // A platform before SUM-1107 names no dropped platforms: nothing is reported missing.
    expect(result).not.toHaveProperty("notIncluded");
  });

  it("goes live on the platforms the release kept and names each one it left out", async () => {
    const store = fakeStore({
      hosted: true,
      checks: [
        { id: "v1", platform: "ios", state: "ready", qualificationId: "q-ios" },
        { id: "v2", platform: "android", state: "ready", qualificationId: "q-android" },
      ],
      drop: [{ target: "ios", buildId: "build-1", qualificationId: "q-ios", reason: "client_check_failed", checkErrorCode: "ios_runtime_unsupported" }],
    });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({
      status: "live",
      build: { livePlatforms: ["android"] },
      notIncluded: [{ platform: "ios", reason: "client_check_failed", checkErrorCode: "ios_runtime_unsupported", message: "iOS isn't included: this build couldn't be checked for iPhone." }],
    });
    expect(String(result.next)).toContain("iOS isn't included: this build couldn't be checked for iPhone.");
  });

  it("goes live and names a newer client the release did not use, in the platform's words", async () => {
    const said = "Your newer Windows build wasn't used because it's built for a newer server. Publish the server too.";
    const store = fakeStore({
      checks: [
        { id: "v1", platform: "ios", state: "ready", qualificationId: "q-ios" },
        { id: "v2", platform: "windows", state: "ready", qualificationId: "q-windows" },
      ],
      notUsed: [{ target: "windows", buildId: "build-1", qualificationId: "q-windows", reason: "client_newer_than_server", message: said }],
    });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "live", build: { livePlatforms: ["ios"] }, notUsed: [{ platform: "windows", reason: "client_newer_than_server", message: said }] });
    expect(result).not.toHaveProperty("notIncluded");
    expect(String(result.next)).toContain(said);
  });

  it.each(["now", "rollout"] as const)("asks for a build with the game's apps when the platform refuses a server-only release (%s)", async (serverOnly) => {
    const store = fakeStore({
      hosted: true,
      serverOnly,
      drop: [{ target: "ios", buildId: "build-0", qualificationId: "q-old", reason: "client_other_build" }],
    });
    const result = await goLive({ gameId: "game-1", confirm: true, waitSeconds: 30, face: "mcp" }, deps(store.fetch));
    expect(result.status).toBe("blocked");
    expect(result.failures).toContainEqual(expect.objectContaining({ code: "playable_release_required", fix: expect.stringContaining("Upload a build that includes your game's apps so they can be checked against the new server.") }));
    if (serverOnly === "rollout") expect(result.notIncluded).toEqual([expect.objectContaining({ platform: "ios", message: "iOS isn't included: select this build's iPhone client." })]);
  });

  it.each(["now", "rollout"] as const)("passes on the platform's own words for a refused release (%s)", async (serverOnly) => {
    const said = "These apps were built for a newer server than the live one. Publish the server too.";
    const store = fakeStore({ hosted: true, serverOnly, serverOnlyMessage: said, drop: [{ target: "ios", buildId: "build-1", qualificationId: "q-ios", reason: "client_newer_than_server" }] });
    const result = await goLive({ gameId: "game-1", confirm: true, waitSeconds: 30, face: "mcp" }, deps(store.fetch));
    expect(result.status).toBe("blocked");
    expect(result.failures).toContainEqual(expect.objectContaining({ code: "playable_release_required", fix: expect.stringContaining(said) }));
    expect(JSON.stringify(result)).not.toContain("Upload a build that includes");
  });

  it("asks for a build with the game's apps when the platform refuses the page for lack of a playable release", async () => {
    // Without a message of its own, the refusal asks for a build with the apps.
    const store = fakeStore({ noBuild: true, pagePublish: { status: 409, code: "playable_release_required", message: "" } });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "blocked", failures: [expect.objectContaining({ code: "playable_release_required" })] });
    expect(String(result.next)).toContain("Upload a build that includes your game's apps so they can be checked against the new server.");
  });

  it("releases a hosted game's server with the platforms that passed, and does not let a failed web check block the rest", async () => {
    const store = fakeStore({
      hosted: true,
      checks: [
        { id: "v1", platform: "ios", state: "ready", qualificationId: "q-ios" },
        { id: "v2", platform: "web", state: "failed", errorCode: "client_platform_unavailable", errorMessage: "a browser cannot join the game's server" },
      ],
    });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result.status).toBe("live");
    const draft = store.calls.find((call) => call.url === `${ENV}/release-drafts`)!;
    expect(draft.body.targets).toEqual({ server: { buildId: "build-1", qualificationId: "" }, ios: { buildId: "build-1", uploadId: "pack-1", qualificationId: "q-ios" } });
    expect(result.notReleased).toEqual([expect.objectContaining({ platform: "web", code: "client_platform_unavailable", fix: expect.stringContaining("download") })]);
  });

  it("reports a platform hold as Summer's, with nothing to fix, and never as a review to wait for", async () => {
    const store = fakeStore({ hold: true });
    const result = await goLive({ gameId: "game-1", confirm: true, waitSeconds: 30, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "waiting", waitingOn: "summer", hold: { by: "summer" } });
    expect(JSON.stringify(result)).not.toMatch(/wait(ing)? for (a |the )?review|in review|until Summer approves/i);
    // A second call continues: it asks with the same keys, so the platform replays instead of asking twice.
    const again = fakeStore({ hold: true, page: { state: "SUBMITTED", etagRevision: 5 } });
    await goLive({ gameId: "game-1", confirm: true, waitSeconds: 0, face: "mcp" }, deps(again.fetch));
    const key = (calls: Call[], suffix: string) => calls.find((call) => call.url.endsWith(suffix))?.headers["idempotency-key"];
    expect(key(again.calls, "rev-1:publish")).toBe(key(store.calls, "rev-1:publish"));
  });

  it("names every missing store page field with its fix and publishes nothing", async () => {
    const store = fakeStore({ page: { contentRating: null, contentDescriptors: null } });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result.status).toBe("blocked");
    expect((result.failures as Array<{ field: string }>).map((failure) => failure.field)).toEqual(["contentRating", "contentDescriptors"]);
    expect(writes(store.calls)).toEqual([]);
  });

  it("passes the platform's missing fields through when it refuses the page", async () => {
    const store = fakeStore({ pagePublish: { status: 422, code: "store_page_incomplete", missing: ["media"] } });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "blocked", failures: [{ field: "media", fix: expect.stringContaining("store.set_art") }] });
  });

  it("says Publish is off in the person's Agent permissions when the platform asks for the owner", async () => {
    const store = fakeStore({ pagePublish: { status: 403, code: "owner_approval_required" } });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result.status).toBe("needs_permission");
    expect(String(result.next)).toMatch(/Agent permissions/);
  });

  it("says Summer is still checking, with nothing to do, when a Publish's checks run long", async () => {
    const store = fakeStore({ hold: true, review: { gameId: "game-1", outcome: "not_live", takenDown: false, message: "", stillCheckingSince: "2026-10-19T09:00:00Z" } });
    const result = await goLive({ gameId: "game-1", confirm: true, waitSeconds: 30, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "waiting", waitingOn: "summer", hold: { by: "summer", stillCheckingSince: "2026-10-19T09:00:00Z" }, review: { stillCheckingSince: "2026-10-19T09:00:00Z" } });
    expect(String(result.next)).toContain("Summer is still checking this; nothing to do on your side.");
    expect(JSON.stringify(result)).not.toMatch(/wait(ing)? for (a |the )?review|in review|until Summer approves/i);
  });

  it("reports Summer's decision and feedback when the page was sent back", async () => {
    const store = fakeStore({
      page: { state: "CHANGES_REQUESTED" },
      review: {
        gameId: "game-1",
        outcome: "not_live",
        takenDown: false,
        message: "",
        latestReview: { decision: "CHANGES_REQUESTED", decidedBy: "automated_checks", feedback: "Use real gameplay screenshots.", review: "store_page", decidedAt: "2026-10-19T09:00:00Z" },
      },
    });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "needs_changes", decision: { decision: "CHANGES_REQUESTED", decidedBy: "automated_checks", feedback: "Use real gameplay screenshots." } });
    expect(writes(store.calls)).toEqual([]);
  });

  it("reads a sent-back page's decision from the older approval route when the platform's review lacks it", async () => {
    const store = fakeStore({
      page: { state: "CHANGES_REQUESTED" },
      review: { gameId: "game-1", outcome: "not_live", takenDown: false, message: "" },
      approval: { gameId: "game-1", state: "PENDING", latestReview: { decision: "CHANGES_REQUESTED", decidedBy: "staff", feedback: "Use real gameplay screenshots." } },
    });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "needs_changes", decision: { decidedBy: "staff", feedback: "Use real gameplay screenshots." } });
  });

  it("still reports a sent-back page when neither route has its decision", async () => {
    for (const approval of [undefined, 500]) {
      const store = fakeStore({ page: { state: "REJECTED" }, review: { gameId: "game-1", outcome: "not_live", takenDown: false, message: "" }, approval });
      const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
      expect(result).toMatchObject({ status: "needs_changes", decision: null });
      expect(String(result.next)).toMatch(/store.status/);
      expect(writes(store.calls)).toEqual([]);
    }
  });

  it("reports a live game Summer put on hold with the changes to make, and publishes nothing", async () => {
    const store = fakeStore({ live: true, review: { gameId: "game-1", outcome: "rejected", takenDown: false, message: "Replace the placeholder title art.", reviewedRevisionId: "rev-1" } });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "on_hold", review: { outcome: "rejected", message: "Replace the placeholder title art." } });
    expect(String(result.next)).toMatch(/store.update_listing/);
    expect(String(result.next)).toMatch(/new build alone does not/);
    expect(writes(store.calls)).toEqual([]);
  });

  it("publishes a newer store page of a game on hold, which lifts the hold", async () => {
    const store = fakeStore({ page: { revisionId: "rev-1", sequence: 2 }, review: { gameId: "game-1", outcome: "rejected", takenDown: false, message: "Replace the art.", reviewedRevisionId: "rev-0" } });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result.status).toBe("live");
  });

  it("stops a taken-down game with what to do, and publishes nothing", async () => {
    const store = fakeStore({ review: { gameId: "game-1", outcome: "approved", takenDown: true, message: "Breaks the community standards." } });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result).toMatchObject({ status: "blocked", failures: [expect.objectContaining({ field: "game", code: "taken_down", message: "Breaks the community standards." })] });
    expect(writes(store.calls)).toEqual([]);
  });

  it("stops on a failed check with its fix when no platform passed", async () => {
    const store = fakeStore({ checks: [{ id: "v1", platform: "ios", state: "failed", errorCode: "package_not_verified", errorMessage: "main scene did not open" }] });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result.status).toBe("blocked");
    expect(result.failures).toContainEqual(expect.objectContaining({ field: "build", code: "no_platform_passed" }));
    expect(writes(store.calls)).toEqual([]);
  });

  it("says live without asking for anything when players already get it", async () => {
    const store = fakeStore({ live: true, buildStatus: "ready" });
    const result = await goLive({ gameId: "game-1", face: "mcp" }, deps(store.fetch));
    expect(result.status).toBe("live");
    expect(writes(store.calls)).toEqual([]);
  });

  it("publishes a page with no bundle Build (web builds and downloads go live with the page)", async () => {
    const store = fakeStore({ noBuild: true });
    const result = await goLive({ gameId: "game-1", confirm: true, face: "mcp" }, deps(store.fetch));
    expect(result.status).toBe("live");
    expect(store.calls.some((call) => call.url.includes("release-drafts"))).toBe(false);
  });
});
