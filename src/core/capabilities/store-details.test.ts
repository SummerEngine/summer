import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PublishBuildDependencies } from "./publish-build.js";
import { setStoreDetails } from "./store-details.js";
import { BuildToolError } from "./summer-bundle.js";

const GATEWAY = "https://gateway.test";
const GAME = `${GATEWAY}/api/creator-store/games/game-1`;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** The store page revisions of one game; PATCH saves what it is sent on the draft it names. */
function fakeStore(newestState = "DRAFT") {
  const calls: Call[] = [];
  const revisions: Array<Record<string, any>> = [{ revisionId: "rev-1", sequence: 1, state: newestState, etagRevision: 3 }];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, headers, body });
    if (method === "GET" && url === `${GAME}/revisions?limit=20`) return json(200, { items: revisions });
    if (method === "POST" && url === `${GAME}/revisions`) {
      const draft = { revisionId: "rev-2", sequence: 2, state: "DRAFT", etagRevision: 1 };
      revisions.push(draft);
      return json(201, draft);
    }
    const patch = url.match(/\/revisions\/(rev-\d)$/);
    if (method === "PATCH" && patch) {
      const revision = revisions.find((row) => row.revisionId === patch[1])!;
      if (revision.state !== "DRAFT") return json(409, { error: { code: "conflict", message: "not a draft" } });
      Object.assign(revision, body, { etagRevision: revision.etagRevision + 1 });
      return json(200, revision);
    }
    return json(404, { error: { code: "not_found" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, revisions };
}

const savedGateway = process.env.SUMMER_GATEWAY_URL;
beforeEach(() => {
  process.env.SUMMER_GATEWAY_URL = GATEWAY;
});
afterEach(() => {
  if (savedGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = savedGateway;
});

const deps = (fetch: typeof globalThis.fetch): Partial<PublishBuildDependencies> => ({ fetch, token: async () => "oauth-access-token" });

const SURVEY = {
  violence: "fantasy",
  bloodGore: "none",
  sexualContent: "none",
  nudity: "none",
  language: "none",
  substances: "none",
  gambling: "none",
  userGeneratedContent: false,
  onlineInteraction: true,
  inGamePurchases: true,
};

async function failure(promise: Promise<unknown>): Promise<BuildToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BuildToolError) return error;
    throw error;
  }
  throw new Error("expected a BuildToolError");
}

describe("setStoreDetails", () => {
  it("saves the given sections on the draft, with its ETag, and leaves the others alone", async () => {
    const store = fakeStore();
    const result = await setStoreDetails(
      { gameId: "game-1", contentSurvey: SURVEY, aiDisclosure: { uses: ["assets"] }, genres: ["puzzle"], face: "mcp" },
      deps(store.fetch)
    );
    expect(result).toMatchObject({ status: "saved", revisionId: "rev-1" });
    const patch = store.calls.find((call) => call.method === "PATCH")!;
    expect(patch.headers["x-summer-revision"]).toBe('"game-revision:rev-1:3"');
    expect(Object.keys(patch.body).sort()).toEqual(["aiDisclosure", "contentSurvey", "genres"]);
    expect(store.revisions[0]).toMatchObject({ contentSurvey: SURVEY, aiDisclosure: { uses: ["assets"] } });
  });

  it("clears a section given null", async () => {
    const store = fakeStore();
    await setStoreDetails({ gameId: "game-1", systemRequirements: null, face: "mcp" }, deps(store.fetch));
    expect(store.calls.find((call) => call.method === "PATCH")!.body).toEqual({ systemRequirements: null });
  });

  it("starts a new draft from a published page instead of editing what players see", async () => {
    const store = fakeStore("PUBLISHED");
    const result = await setStoreDetails({ gameId: "game-1", features: ["single_player"], face: "mcp" }, deps(store.fetch));
    expect(result.revisionId).toBe("rev-2");
    expect(store.revisions[0]).not.toHaveProperty("features");
  });

  it("refuses while the page is being published, and changes nothing", async () => {
    const store = fakeStore("VERIFYING");
    const error = await failure(setStoreDetails({ gameId: "game-1", genres: ["puzzle"], face: "mcp" }, deps(store.fetch)));
    expect(error.code).toBe("page_publishing");
    expect(error.message).not.toMatch(/review/i);
    expect(store.calls.some((call) => call.method !== "GET")).toBe(false);
  });

  it("asks for the description AI-generated gameplay needs before sending anything", async () => {
    const store = fakeStore();
    const error = await failure(setStoreDetails({ gameId: "game-1", aiDisclosure: { uses: ["generatedGameplay"] }, face: "mcp" }, deps(store.fetch)));
    expect(error.code).toBe("ai_disclosure_incomplete");
    expect(store.calls).toEqual([]);
  });

  it("needs at least one section", async () => {
    const store = fakeStore();
    expect((await failure(setStoreDetails({ gameId: "game-1", face: "mcp" }, deps(store.fetch)))).code).toBe("nothing_to_change");
  });
});
