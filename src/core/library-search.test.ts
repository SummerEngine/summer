import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.js", () => ({
  getAuthToken: vi.fn(),
}));

import { getAuthToken } from "./auth.js";
import { EMBEDDINGS_ENCODING, encodeVector, type EmbeddingsFile } from "./embeddings.js";
import {
  _resetLibrarySearchForTests,
  embedQueryWithConfiguredProvider,
  loadLibraryIndex,
  PREVIEW_SCORE_FACTOR,
  runSearchLibrary,
  searchLibrary,
  searchLibraryDetailed,
  searchLibraryInputSchema,
  statusScoreFactor,
  type LibraryIndexEntry,
} from "./library-search.js";

const mockedGetAuthToken = vi.mocked(getAuthToken);

/** A small corpus with every filter case: kinds, preview, deprecated, ties. */
const corpus: LibraryIndexEntry[] = [
  {
    id: "skill/vfx-water-ripple",
    kind: "skill",
    status: "stable",
    content_hash: "a".repeat(64),
    summary: "Water-ripple effect — animated ripples on a water plane.",
    use_when: ["authoring a water-ripple effect — raindrop ripples, splash ripples"],
    facets: { domains: ["vfx"] },
  },
  {
    id: "tool/screenshot",
    kind: "tool",
    status: "stable",
    summary: "Capture an editor viewport, scene render, or game frame.",
    use_when: ["seeing what the water plane looks like right now"],
    mcp_tool_name: "summer_screenshot",
    remote: false,
  },
  {
    id: "skill/psx-water-shader",
    kind: "skill",
    status: "preview",
    summary: "Retro water shader with vertex wobble.",
    use_when: ["a retro water look"],
  },
  {
    id: "skill/old-water",
    kind: "skill",
    status: "deprecated",
    summary: "Deprecated water plane recipe.",
    use_when: ["water plane"],
  },
  {
    id: "skill/ocean-waves",
    kind: "skill",
    status: "stable",
    summary: "Large-scale ocean wave displacement (Gerstner) for open-sea scenes.",
    use_when: ["an open sea with rolling waves"],
  },
  {
    id: "template/beach-day",
    kind: "template",
    status: "stable",
    summary: "Summer beach starter with sand, sea, and a boardwalk.",
    use_when: ["starting a beach game"],
  },
  { id: "skill/tie-b", kind: "skill", status: "stable", summary: "Identical text for ties.", use_when: ["tie"] },
  { id: "skill/tie-a", kind: "skill", status: "stable", summary: "Identical text for ties.", use_when: ["tie"] },
];

const lexicalOnly = { embeddings: null } as const;

beforeEach(() => {
  _resetLibrarySearchForTests();
  mockedGetAuthToken.mockReset();
  mockedGetAuthToken.mockResolvedValue(null);
  vi.stubEnv("SUMMER_EMBED_URL", "");
  vi.stubEnv("SUMMER_GATEWAY_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("lexical ranking over the shipped index", () => {
  it("'make stylized water' puts skill/vfx-water-ripple in the top 3, lexical only", async () => {
    const hits = await searchLibrary("make stylized water", { limit: 3 }, lexicalOnly);
    expect(hits.slice(0, 3).map((h) => h.id)).toContain("skill/vfx-water-ripple");
    for (const hit of hits) {
      expect(hit.matched_by).toEqual(["lexical"]);
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.status).toBeTruthy();
    }
  });

  it("returns at most `limit` hits, default 8, clamped to 1..20", async () => {
    expect((await searchLibrary("game", {}, lexicalOnly)).length).toBeLessThanOrEqual(8);
    expect((await searchLibrary("game", { limit: 3 }, lexicalOnly)).length).toBe(3);
    expect((await searchLibrary("game", { limit: 500 }, lexicalOnly)).length).toBeLessThanOrEqual(20);
    expect((await searchLibrary("game", { limit: 0 }, lexicalOnly)).length).toBe(1);
  });

  it("tool hits carry mcp_tool_name so a hit can become a call", async () => {
    const hits = await searchLibrary("take a screenshot of the game", { kinds: ["tool"], limit: 3 }, lexicalOnly);
    expect(hits[0]!.id).toBe("tool/screenshot");
    expect(hits[0]!.mcp_tool_name).toBe("summer_screenshot");
  });

  it("the shipped index loads and every entry has an id and kind", () => {
    const entries = loadLibraryIndex();
    expect(entries.length).toBeGreaterThan(100);
    for (const entry of entries) expect(entry.id).toMatch(/^[a-z]+\/[a-z0-9-]+$/);
  });
});

describe("filters (fixture corpus)", () => {
  it("kinds restricts to the named kinds", async () => {
    const tools = await searchLibrary("water", { kinds: ["tool"] }, { entries: corpus, ...lexicalOnly });
    expect(tools.map((h) => h.id)).toEqual(["tool/screenshot"]);
    const mixed = await searchLibrary("water", { kinds: ["tool", "template"] }, { entries: corpus, ...lexicalOnly });
    expect(mixed.map((h) => h.kind).sort()).toEqual(["tool"]);
  });

  it("include_preview:false hides preview entries; default includes them", async () => {
    const withPreview = await searchLibrary("retro water", {}, { entries: corpus, ...lexicalOnly });
    expect(withPreview.map((h) => h.id)).toContain("skill/psx-water-shader");
    const stableOnly = await searchLibrary("retro water", { includePreview: false }, { entries: corpus, ...lexicalOnly });
    expect(stableOnly.map((h) => h.id)).not.toContain("skill/psx-water-shader");
    expect(stableOnly.length).toBeGreaterThan(0);
  });

  it("deprecated entries never surface", async () => {
    const hits = await searchLibrary("water plane", {}, { entries: corpus, ...lexicalOnly });
    expect(hits.map((h) => h.id)).not.toContain("skill/old-water");
  });

  it("ties break on id, so ordering is deterministic", async () => {
    const hits = await searchLibrary("identical text for ties", {}, { entries: corpus, ...lexicalOnly });
    const tieIds = hits.filter((h) => h.id.startsWith("skill/tie-")).map((h) => h.id);
    expect(tieIds).toEqual(["skill/tie-a", "skill/tie-b"]);
  });
});

describe("semantic fusion (mocked provider + mocked embeddings file)", () => {
  // Query embeds to [1,0,0,0]. ocean-waves shares no token with the query
  // but sits next to it in vector space; vfx-water-ripple matches both ways;
  // screenshot only lexically.
  const embeddings: EmbeddingsFile = {
    model: "mock",
    dims: 4,
    encoding: EMBEDDINGS_ENCODING,
    entries: {
      "skill/ocean-waves": { content_hash: "x", vector: encodeVector([1, 0, 0, 0]) },
      "skill/vfx-water-ripple": { content_hash: "y", vector: encodeVector([0.9, 0.1, 0, 0]) },
      "tool/screenshot": { content_hash: "z", vector: encodeVector([0, 0, 1, 0]) },
      "skill/old-water": { content_hash: "w", vector: encodeVector([1, 0, 0, 0]) },
    },
  };

  it("fuses lexical and semantic rankings and labels matched_by per hit", async () => {
    const embedQuery = vi.fn().mockResolvedValue([1, 0, 0, 0]);
    const { hits, semantic } = await searchLibraryDetailed("splash ripples on the water plane", {}, { entries: corpus, embeddings, embedQuery });
    expect(semantic).toBe(true);
    expect(embedQuery).toHaveBeenCalledWith("splash ripples on the water plane");
    const byId = new Map(hits.map((h) => [h.id, h]));
    expect(byId.get("skill/vfx-water-ripple")!.matched_by).toEqual(["lexical", "semantic"]);
    expect(byId.get("skill/ocean-waves")!.matched_by).toEqual(["semantic"]);
    expect(byId.get("tool/screenshot")!.matched_by).toEqual(["lexical"]);
    // Matched on both sides -> first.
    expect(hits[0]!.id).toBe("skill/vfx-water-ripple");
    // Deprecated stays hidden even with a perfect vector.
    expect(byId.has("skill/old-water")).toBe(false);
  });

  it("kinds and include_preview apply to the semantic side too", async () => {
    const embedQuery = vi.fn().mockResolvedValue([1, 0, 0, 0]);
    const hits = await searchLibrary("water", { kinds: ["tool"] }, { entries: corpus, embeddings, embedQuery });
    expect(hits.map((h) => h.id)).toEqual(["tool/screenshot"]);
  });

  it("a query vector with the wrong dims falls back to lexical", async () => {
    const embedQuery = vi.fn().mockResolvedValue([1, 0]);
    const { hits, semantic } = await searchLibraryDetailed("water", {}, { entries: corpus, embeddings, embedQuery });
    expect(semantic).toBe(false);
    for (const hit of hits) expect(hit.matched_by).toEqual(["lexical"]);
  });

  it("offline / provider failure -> lexical only, matched_by lexical, never throws", async () => {
    for (const embedQuery of [vi.fn().mockResolvedValue(null), vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))]) {
      const { hits, semantic } = await searchLibraryDetailed("water", {}, { entries: corpus, embeddings, embedQuery });
      expect(semantic).toBe(false);
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(hit.matched_by).toEqual(["lexical"]);
    }
  });

  it("no embeddings file -> the provider is never called", async () => {
    const embedQuery = vi.fn();
    const { semantic } = await searchLibraryDetailed("water", {}, { entries: corpus, embeddings: null, embedQuery });
    expect(semantic).toBe(false);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it("SUMMER_EMBED_URL=off disables the semantic side even with embeddings present", async () => {
    const embedQuery = vi.fn().mockResolvedValue([1, 0, 0, 0]);
    const { semantic } = await searchLibraryDetailed("water", {}, { entries: corpus, embeddings, embedQuery, env: { SUMMER_EMBED_URL: "off" } });
    expect(semantic).toBe(false);
    expect(embedQuery).not.toHaveBeenCalled();
  });
});

describe("embedQueryWithConfiguredProvider (default wiring)", () => {
  it("POSTs the query to SUMMER_EMBED_URL with the account token when logged in", async () => {
    mockedGetAuthToken.mockResolvedValue("tok-9");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ vector: [0.5, 0.5] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const vector = await embedQueryWithConfiguredProvider("make water", { SUMMER_EMBED_URL: "https://embed.example.test/v1" });
    expect(vector).toEqual([0.5, 0.5]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://embed.example.test/v1");
    expect(JSON.parse(init.body as string)).toEqual({ text: "make water" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-9");
  });

  it("defaults to <gateway>/api/mcp/embed and sends no token when logged out", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ vector: [1] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SUMMER_GATEWAY_URL", "https://staging.example.com/");
    await embedQueryWithConfiguredProvider("q", { SUMMER_EMBED_URL: "" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://staging.example.com/api/mcp/embed");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("returns null on network failure, non-2xx, or an auth-store error — never throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await embedQueryWithConfiguredProvider("q", { SUMMER_EMBED_URL: "https://x.test/e" })).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    expect(await embedQueryWithConfiguredProvider("q", { SUMMER_EMBED_URL: "https://x.test/e" })).toBeNull();
    mockedGetAuthToken.mockRejectedValue(new Error("store broken"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ vector: [1] }), { status: 200 })));
    expect(await embedQueryWithConfiguredProvider("q", { SUMMER_EMBED_URL: "https://x.test/e" })).toEqual([1]);
  });

  it("'off' short-circuits without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await embedQueryWithConfiguredProvider("q", { SUMMER_EMBED_URL: "off" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("tool payload and input schema", () => {
  it("runSearchLibrary returns the list plus a one-line read hint naming the top id", async () => {
    const payload = await runSearchLibrary({ query: "make stylized water", limit: 2 }, lexicalOnly);
    expect(payload.count).toBe(2);
    expect(payload.semantic).toBe(false);
    expect(payload.hint).toContain("summer_read_library");
    expect(payload.hint).toContain(payload.results[0]!.id);
    expect(payload.hint.split("\n")).toHaveLength(1);
  });

  it("an empty result set gets a rephrase hint instead of a read hint", async () => {
    const payload = await runSearchLibrary({ query: "zzqx" }, { entries: corpus, ...lexicalOnly });
    expect(payload.count).toBe(0);
    expect(payload.hint).toMatch(/No entry matched/);
  });

  it("schema: query 1-300 chars required, kinds from the six kinds, limit 1-20 integer", () => {
    expect(searchLibraryInputSchema.safeParse({ query: "x" }).success).toBe(true);
    expect(searchLibraryInputSchema.safeParse({ query: "" }).success).toBe(false);
    expect(searchLibraryInputSchema.safeParse({ query: "x".repeat(301) }).success).toBe(false);
    expect(searchLibraryInputSchema.safeParse({ query: "x", kinds: ["skill", "collection"] }).success).toBe(true);
    expect(searchLibraryInputSchema.safeParse({ query: "x", kinds: ["recipe"] }).success).toBe(false);
    expect(searchLibraryInputSchema.safeParse({ query: "x", limit: 21 }).success).toBe(false);
    expect(searchLibraryInputSchema.safeParse({ query: "x", limit: 2.5 }).success).toBe(false);
    expect(searchLibraryInputSchema.safeParse({ query: "x", include_preview: false }).success).toBe(true);
    expect(searchLibraryInputSchema.safeParse({ query: "x", extra: 1 }).success).toBe(false);
  });
});

describe("status penalty: preview never outranks stable on comparable evidence (E2E F-18)", () => {
  const twins: LibraryIndexEntry[] = [
    {
      id: "skill/aaa-preview-jump",
      kind: "skill",
      status: "preview",
      summary: "Tune the platformer jump so it feels better.",
      use_when: ["make the platformer jump feel better"],
    },
    {
      id: "skill/zzz-stable-jump",
      kind: "skill",
      status: "stable",
      summary: "Tune the platformer jump so it feels better.",
      use_when: ["make the platformer jump feel better"],
    },
    {
      id: "skill/unrelated",
      kind: "skill",
      status: "stable",
      summary: "Bake lightmaps for a 3D level.",
      use_when: ["lightmaps look wrong"],
    },
  ];

  it("multiplies preview scores by PREVIEW_SCORE_FACTOR so an equal-text stable twin leads (ids alone would put preview first)", async () => {
    const hits = await searchLibrary("make the platformer jump feel better", {}, { entries: twins, ...lexicalOnly });
    expect(hits.map((hit) => hit.id)).toEqual(["skill/zzz-stable-jump", "skill/aaa-preview-jump"]);
    const [stable, preview] = hits;
    expect(preview!.score).toBeCloseTo(stable!.score * PREVIEW_SCORE_FACTOR, 3);
    expect(statusScoreFactor("preview")).toBe(PREVIEW_SCORE_FACTOR);
    expect(statusScoreFactor("stable")).toBe(1);
    expect(statusScoreFactor(undefined)).toBe(1);
  });

  it("is a factor, not a gate: a preview entry with a clear lexical margin still wins, and include_preview:false still removes it", async () => {
    const margin: LibraryIndexEntry[] = [
      {
        id: "skill/preview-dash",
        kind: "skill",
        status: "preview",
        summary: "Dash mechanic with dash cooldown and dash trail.",
        use_when: ["add a dash", "dash cooldown", "dash trail"],
      },
      { id: "skill/stable-move", kind: "skill", status: "stable", summary: "Basic movement.", use_when: ["move the player"] },
    ];
    const hits = await searchLibrary("dash cooldown", {}, { entries: margin, ...lexicalOnly });
    expect(hits[0]!.id).toBe("skill/preview-dash");
    const stableOnly = await searchLibrary("dash cooldown", { includePreview: false }, { entries: margin, ...lexicalOnly });
    expect(stableOnly.map((hit) => hit.id)).not.toContain("skill/preview-dash");
  });

  it("applies the same factor on the semantic side", async () => {
    const embeddings: EmbeddingsFile = {
      version: 1,
      model: "test-model",
      dims: 2,
      encoding: EMBEDDINGS_ENCODING,
      entries: {
        // preview cosine 0.95 vs stable 0.90: preview leads raw, stable leads after x0.8.
        "skill/aaa-preview-jump": { content_hash: "a".repeat(64), vector: encodeVector([0.95, 0.312]) },
        "skill/zzz-stable-jump": { content_hash: "b".repeat(64), vector: encodeVector([0.9, 0.436]) },
      },
    };
    const result = await searchLibraryDetailed(
      "words that match nothing lexically",
      {},
      { entries: twins, embeddings, embedQuery: async () => [1, 0] }
    );
    expect(result.semantic).toBe(true);
    expect(result.hits.map((hit) => hit.id)).toEqual(["skill/zzz-stable-jump", "skill/aaa-preview-jump"]);
  });

  it("against the shipped index, 'make the platformer jump feel better' leads with the stable debugging-game-feel", async () => {
    const hits = await searchLibrary("make the platformer jump feel better", {}, lexicalOnly);
    const ids = hits.map((hit) => hit.id);
    expect(ids[0]).toBe("skill/debugging-game-feel");
    expect(ids.indexOf("skill/celeste-momentum-platforming")).toBeGreaterThan(0);
  });
});
