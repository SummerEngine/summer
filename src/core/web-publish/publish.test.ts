import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readStoreJson, setSummerDirForTests, writeStoreJson } from "../store.js";
import { publishWebGame, zipFileName, WebPublishError, type WebPublishDependencies } from "./publish.js";

const API = "https://api.summer.games/v1/management";
const GAME = "game_01ABC";
const VERSION = "sv_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const REV = "grev_01XYZ";

function jwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "ES256" })}.${enc(claims)}.sig`;
}
const TOKEN = jwt({ sub: "u1", aud: "authenticated", exp: 4e9 });

let root = "";
let build = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-publish-web-"));
  setSummerDirForTests(join(root, ".summer"));
  build = join(root, "build");
  await mkdir(join(build, "assets"), { recursive: true });
  await writeFile(join(build, "index.html"), '<!doctype html><script src="game.js"></script>');
  // Incompressible-ish payload so the zip spans several 256-byte parts.
  await writeFile(join(build, "game.js"), Buffer.from(Array.from({ length: 900 }, (_, i) => (i * 7919) % 251)));
  await writeFile(join(build, "assets", "a.png"), "png");
});
afterEach(async () => {
  setSummerDirForTests(null);
  delete process.env.SUMMER_GAMES_API_URL;
  await rm(root, { recursive: true, force: true });
});

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function harness(routes: Array<[string, string | RegExp, Handler]>, extra: Partial<WebPublishDependencies> = {}) {
  const calls: Recorded[] = [];
  let clock = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body =
      init.body instanceof Buffer
        ? init.body
        : typeof init.body === "string"
          ? JSON.parse(init.body)
          : undefined;
    calls.push({ method, url, headers: (init.headers ?? {}) as Record<string, string>, body });
    for (const [m, pattern, handler] of routes) {
      if (m === method && (typeof pattern === "string" ? url === pattern : pattern.test(url))) return handler(url, init);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  const deps: Partial<WebPublishDependencies> = {
    fetch: fetchMock as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    randomId: (() => {
      let n = 0;
      return () => `idem-${++n}`;
    })(),
    getAccessToken: async () => TOKEN,
    ...extra,
  };
  return { calls, deps };
}

const PART = 256;

function happyRoutes(options: { revisionState?: string; contentRating?: string } = {}) {
  let sizeBytes = 0;
  const received = new Map<number, Buffer>();
  let polls = 0;
  const routes: Array<[string, string | RegExp, Handler]> = [
    ["GET", /\/games\?limit=100$/, () => Response.json({ items: [{ id: "game_other", name: "Other" }], nextCursor: "" })],
    ["POST", `${API}/games`, () => Response.json({ gameId: GAME, revision: { revisionId: REV, state: "DRAFT" } }, { status: 201 })],
    [
      "POST",
      `${API}/games/${GAME}/store/versions`,
      (_url, init) => {
        sizeBytes = JSON.parse(String(init.body)).sizeBytes;
        return Response.json(
          {
            version: { id: VERSION, status: "awaiting_upload" },
            upload: { uploadId: "up", partSizeBytes: PART, partCount: Math.ceil(sizeBytes / PART) },
          },
          { status: 201 }
        );
      },
    ],
    [
      "POST",
      `${API}/games/${GAME}/store/versions/${VERSION}:signParts`,
      (_url, init) => {
        const { partNumbers } = JSON.parse(String(init.body)) as { partNumbers: number[] };
        return Response.json({
          parts: partNumbers.map((n) => ({
            partNumber: n,
            method: "PUT",
            url: `https://s3.example/upload?partNumber=${n}`,
            headers: { "x-amz-meta": "v", host: "s3.example" },
            expiresAt: "2026-10-06T00:00:00Z",
          })),
        });
      },
    ],
    [
      "PUT",
      /^https:\/\/s3\.example\/upload\?partNumber=\d+$/,
      (url, init) => {
        received.set(Number(new URL(url).searchParams.get("partNumber")), Buffer.from(init.body as Buffer));
        return new Response(null, { status: 200, headers: { etag: '"x"' } });
      },
    ],
    ["POST", `${API}/games/${GAME}/store/versions/${VERSION}:complete`, () => Response.json({ version: { id: VERSION, status: "processing" } })],
    [
      "GET",
      `${API}/games/${GAME}/store/versions/${VERSION}`,
      () => {
        polls += 1;
        return Response.json(
          polls < 2
            ? { id: VERSION, status: "processing" }
            : { id: VERSION, status: "ready", playUrl: `https://play.example/g/${GAME}/${VERSION}/` }
        );
      },
    ],
    [
      "GET",
      `${API}/games/${GAME}`,
      () => Response.json({ id: GAME, creatorRevisionId: REV, creatorState: options.revisionState ?? "DRAFT" }),
    ],
    [
      "GET",
      `${API}/games/${GAME}/revisions/${REV}`,
      () =>
        Response.json(
          { revisionId: REV, state: "DRAFT", etagRevision: 1, contentRating: options.contentRating ?? "", contentDescriptors: options.contentRating ? [] : null },
          { headers: { etag: `"game-revision:${REV}:1"` } }
        ),
    ],
    [
      "PATCH",
      `${API}/games/${GAME}/revisions/${REV}`,
      () => Response.json({ revisionId: REV, state: "DRAFT", etagRevision: 2, contentRating: "everyone", contentDescriptors: [] }, { headers: { etag: `"game-revision:${REV}:2"` } }),
    ],
    ["POST", `${API}/games/${GAME}/revisions/${REV}:submit`, () => Response.json({ operationId: "op_1", status: "pending", verificationRunId: "vr" }, { status: 202 })],
    ["POST", `${API}/games/${GAME}/revisions/${REV}:publish`, () => Response.json({ operationId: "op_pub", status: "pending" }, { status: 202 })],
  ];
  return { routes, received, size: () => sizeBytes };
}

describe("publishWebGame", () => {
  it("requires confirmation, validates locally and uploads nothing", async () => {
    const { calls, deps } = harness([]);
    const error = await publishWebGame({ path: build, name: "Space Cats", face: "cli" }, deps).catch((e) => e);
    expect(error).toBeInstanceOf(WebPublishError);
    expect(error.code).toBe("publish_confirmation_required");
    expect(error.details.plan).toMatchObject({ fileCount: 3, name: "Space Cats", gameId: null, submit: true });
    expect(calls).toEqual([]);
  });

  it("requires a name when the build is not linked to a game", async () => {
    const { deps } = harness([]);
    await expect(publishWebGame({ path: build, confirm: true, face: "cli" }, deps)).rejects.toMatchObject({ code: "games_name_required" });
  });

  it("creates the game, uploads every part with exact bytes, completes, waits, rates and submits for review", async () => {
    const happy = happyRoutes();
    const { calls, deps } = harness(happy.routes);
    const result = await publishWebGame(
      { path: build, name: "Space Cats", contentRating: "everyone", label: "v1", confirm: true, face: "cli" },
      deps
    );

    // Request shapes.
    const create = calls.find((c) => c.method === "POST" && c.url === `${API}/games`)!;
    expect(create.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(create.headers["idempotency-key"]).toMatch(/^idem-/);
    expect(create.body).toEqual({
      name: "Space Cats",
      description: "Space Cats is a game you can play in your browser.",
      tags: [],
      supportedPlatforms: ["web"],
      contentRating: "everyone",
      contentDescriptors: [],
    });
    const version = calls.find((c) => c.url === `${API}/games/${GAME}/store/versions`)!;
    expect(version.body).toEqual({ platform: "web", fileName: "build.zip", sizeBytes: happy.size(), label: "v1" });
    const complete = calls.find((c) => c.url.endsWith(":complete"))!;
    expect(complete.body).toEqual({});

    // Upload sequencing: sign before put, all parts, reassembled bytes equal the zip size; host header stripped.
    const order = calls.map((c) => `${c.method} ${c.url.replace(API, "")}`);
    const signIndex = order.findIndex((o) => o.includes(":signParts"));
    const firstPut = order.findIndex((o) => o.startsWith("PUT"));
    const completeIndex = order.findIndex((o) => o.includes(":complete"));
    expect(signIndex).toBeLessThan(firstPut);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.length).toBe(Math.ceil(happy.size() / PART));
    expect(puts.length).toBeGreaterThan(1);
    expect(order.lastIndexOf(order.filter((o) => o.startsWith("PUT")).pop()!)).toBeLessThan(completeIndex);
    expect(puts[0]!.headers).toEqual({ "x-amz-meta": "v" });
    const assembled = Buffer.concat([...happy.received.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
    expect(assembled.length).toBe(happy.size());
    expect(assembled.readUInt32LE(0)).toBe(0x04034b50);

    // Review: rating PATCH with If-Match, then submit with the new ETag.
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.headers["if-match"]).toBe(`"game-revision:${REV}:1"`);
    expect(patch.body).toEqual({ contentRating: "everyone", contentDescriptors: [] });
    const submit = calls.find((c) => c.url.endsWith(":submit"))!;
    expect(submit.headers["if-match"]).toBe(`"game-revision:${REV}:2"`);
    expect(submit.headers["idempotency-key"]).toBeTruthy();

    expect(result).toMatchObject({
      ok: true,
      gameId: GAME,
      gameCreated: true,
      versionId: VERSION,
      versionStatus: "ready",
      playUrl: `https://play.example/g/${GAME}/${VERSION}/`,
      storeUrl: `https://summer.games/games/${GAME}`,
      review: { outcome: "submitted_for_review", operationId: "op_1" },
    });
    expect(await readStoreJson<{ builds: Record<string, { gameId: string }> }>("games-web-publish.json")).toMatchObject({
      builds: { [build]: { gameId: GAME } },
    });
    const audit = await readFile(join(root, ".summer", "games-publish-audit.jsonl"), "utf8");
    expect(audit).toContain('"outcome":"succeeded"');
    expect(audit).not.toContain(TOKEN);
  });

  it("reuses the game linked to this build folder and reports a live game without resubmitting", async () => {
    await writeStoreJson("games-web-publish.json", { schemaVersion: 1, builds: { [build]: { gameId: GAME, name: "Space Cats", updatedAt: "x" } } });
    const happy = happyRoutes({ revisionState: "PUBLISHED" });
    const { calls, deps } = harness(happy.routes);
    const result = await publishWebGame({ path: build, confirm: true, face: "mcp" }, deps);
    expect(calls.some((c) => c.method === "POST" && c.url === `${API}/games`)).toBe(false);
    expect(calls.some((c) => c.url.endsWith(":submit"))).toBe(false);
    expect(result).toMatchObject({ gameCreated: false, review: { outcome: "live" } });
  });

  it("reuses an owned game with the exact same name", async () => {
    const happy = happyRoutes({ contentRating: "teen" });
    happy.routes[0] = ["GET", /\/games\?limit=100$/, () => Response.json({ items: [{ id: GAME, name: "Space Cats" }], nextCursor: "" })];
    const { calls, deps } = harness(happy.routes);
    const result = await publishWebGame({ path: build, name: "Space Cats", confirm: true, face: "cli" }, deps);
    expect(result.gameCreated).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(result.review.outcome).toBe("submitted_for_review");
  });

  it("publishes an approved listing", async () => {
    const happy = happyRoutes({ revisionState: "APPROVED" });
    const { deps } = harness(happy.routes);
    const result = await publishWebGame({ path: build, gameId: GAME, confirm: true, face: "cli" }, deps);
    expect(result.review).toMatchObject({ outcome: "publishing", operationId: "op_pub" });
  });

  it("asks for a content rating instead of submitting an incomplete listing", async () => {
    const happy = happyRoutes();
    const { calls, deps } = harness(happy.routes);
    const result = await publishWebGame({ path: build, gameId: GAME, confirm: true, face: "cli" }, deps);
    expect(result.review.outcome).toBe("needs_content_rating");
    expect(calls.some((c) => c.url.endsWith(":submit"))).toBe(false);
  });

  it("stops waiting after waitSeconds and does not submit a processing build", async () => {
    const happy = happyRoutes();
    happy.routes[6] = ["GET", `${API}/games/${GAME}/store/versions/${VERSION}`, () => Response.json({ id: VERSION, status: "processing" })];
    const { calls, deps } = harness(happy.routes);
    const result = await publishWebGame({ path: build, gameId: GAME, waitSeconds: 6, confirm: true, face: "cli" }, deps);
    expect(result.versionStatus).toBe("processing");
    expect(result.review.outcome).toBe("skipped");
    expect(calls.filter((c) => c.url.endsWith(VERSION) && c.method === "GET").length).toBe(2);
  });

  it("reports a server rejection reason", async () => {
    const happy = happyRoutes();
    happy.routes[6] = [
      "GET",
      `${API}/games/${GAME}/store/versions/${VERSION}`,
      () => Response.json({ id: VERSION, status: "rejected", rejectionReason: "index.html must be at the root of the zip" }),
    ];
    const { deps } = harness(happy.routes);
    const result = await publishWebGame({ path: build, gameId: GAME, confirm: true, face: "cli" }, deps);
    expect(result).toMatchObject({ versionStatus: "rejected", rejectionReason: "index.html must be at the root of the zip", review: { outcome: "skipped" } });
  });

  it("retries a failed part upload and then succeeds", async () => {
    const happy = happyRoutes();
    let failures = 1;
    const putRoute = happy.routes.findIndex((r) => r[0] === "PUT");
    const original = happy.routes[putRoute]![2];
    happy.routes[putRoute] = [
      "PUT",
      /^https:\/\/s3\.example\/upload\?partNumber=\d+$/,
      (url, init) => (failures-- > 0 ? new Response("boom", { status: 500 }) : original(url, init)),
    ];
    const { deps } = harness(happy.routes);
    await expect(publishWebGame({ path: build, gameId: GAME, confirm: true, face: "cli" }, deps)).resolves.toMatchObject({ versionStatus: "ready" });
  });

  it("maps a non-JSON 404 on store routes to games_store_unavailable", async () => {
    const { deps } = harness([
      ["POST", `${API}/games/${GAME}/store/versions`, () => new Response("404 page not found\n", { status: 404 })],
    ]);
    await expect(publishWebGame({ path: build, gameId: GAME, confirm: true, face: "cli" }, deps)).rejects.toMatchObject({
      code: "games_store_unavailable",
      status: 404,
    });
  });

  it("maps the management error envelope", async () => {
    const { deps } = harness([
      [
        "POST",
        `${API}/games/${GAME}/store/versions`,
        () => Response.json({ error: { code: "not_signed_in", message: "present a valid developer credential", requestId: "rq", retryable: false } }, { status: 401 }),
      ],
    ]);
    const error = await publishWebGame({ path: build, gameId: GAME, confirm: true, face: "cli" }, deps).catch((e) => e);
    expect(error).toMatchObject({ code: "not_signed_in", status: 401, details: { requestId: "rq" } });
    expect(error.recovery).toContain("summer login --games --force");
  });

  it("refuses a token whose audience the management API rejects, before any request", async () => {
    const { calls, deps } = harness([], {
      getAccessToken: async () => jwt({ sub: "u1", aud: "https://mcp.summerengine.com/mcp", client_id: "c" }),
    });
    await expect(publishWebGame({ path: build, gameId: GAME, confirm: true, face: "cli" }, deps)).rejects.toMatchObject({
      code: "games_token_audience_mismatch",
    });
    expect(calls).toEqual([]);
  });

  it("validates inputs before touching the network", async () => {
    const { deps } = harness([]);
    await expect(publishWebGame({ path: build, gameId: "nope", confirm: true, face: "cli" }, deps)).rejects.toMatchObject({ code: "games_id_invalid" });
    await expect(publishWebGame({ path: build, name: "X", contentRating: "adult", confirm: true, face: "cli" }, deps)).rejects.toMatchObject({
      code: "games_content_rating_invalid",
    });
    await expect(publishWebGame({ path: join(root, "missing"), name: "X", face: "cli" }, deps)).rejects.toMatchObject({ code: "web_build_not_found" });
  });

  it("honours SUMMER_GAMES_API_URL for staging", async () => {
    process.env.SUMMER_GAMES_API_URL = "https://api.staging.summer.games";
    const { calls, deps } = harness([
      ["POST", "https://api.staging.summer.games/v1/management/games/game_01ABC/store/versions", () => new Response("nope", { status: 404 })],
    ]);
    await publishWebGame({ path: build, gameId: GAME, confirm: true, face: "cli" }, deps).catch(() => {});
    expect(calls[0]!.url.startsWith("https://api.staging.summer.games/")).toBe(true);
  });
});

describe("zipFileName", () => {
  it("produces a server-valid file name", () => {
    expect(zipFileName("/x/My Game (web)!")).toBe("My Game -web-.zip");
    expect(zipFileName("/x/_dist.zip")).toBe("dist.zip");
    expect(zipFileName("/x/!!!")).toBe("web-build.zip");
  });
});
