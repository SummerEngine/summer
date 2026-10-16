import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSummerDirForTests } from "../store.js";
import { ITEMS_MANIFEST_SCHEMA, parseItemsManifest, type ManifestItem } from "./item-manifest.js";
import { planItem, syncItems, type LocalMedia, type ProposeItemsRequest, type RemoteItem, type SyncItemsDependencies } from "./sync-items.js";
import { BuildToolError } from "./summer-bundle.js";

const GATEWAY = "https://staging-gateway.test";
const STORE = `${GATEWAY}/api/creator-store`;
const PNG = Buffer.from("\x89PNG fake ponder pixels");
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

const PONDER = {
  slug: "emote_ponder",
  name: "Ponder",
  description: "Strike a thoughtful pose.",
  class: "COSMETIC",
  cosmetic: { familyId: "emote", variantKey: "ponder" },
  tags: ["emote"],
  priceSparks: 150,
  media: ["art/emote_ponder.png"],
};

async function failure(promise: Promise<unknown> | (() => unknown)): Promise<BuildToolError> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    if (error instanceof BuildToolError) return error;
    throw error;
  }
  throw new Error("expected a BuildToolError");
}

function manifestItem(overrides: Record<string, unknown> = {}): ManifestItem {
  return parseItemsManifest("/project", { schema: ITEMS_MANIFEST_SCHEMA, items: [{ ...PONDER, ...overrides }] }).items[0];
}

describe("summer.items.json", () => {
  it("reports every problem at once and accepts nothing from a file with one", async () => {
    const error = await failure(() =>
      parseItemsManifest("/project", {
        schema: ITEMS_MANIFEST_SCHEMA,
        items: [
          { ...PONDER, slug: "Emote Ponder" },
          { ...PONDER, slug: "emote_wave", cosmetic: undefined },
          { ...PONDER, slug: "emote_bow", media: ["../outside.png"] },
          { ...PONDER },
          { ...PONDER },
        ],
      })
    );
    expect(error.code).toBe("items_manifest_invalid");
    const problems = (error.detail as { problems: string[] }).problems.join("\n");
    expect(problems).toContain("slug:");
    expect(problems).toContain("emote_wave");
    expect(problems).toContain("outside the project");
    expect(problems).toContain("same slug is used twice");
  });

  it("refuses a slug the platform would refuse", async () => {
    for (const slug of ["", "9lives", "emote__ponder", "emote-", "a".repeat(65)]) {
      const error = await failure(() => parseItemsManifest("/project", { schema: ITEMS_MANIFEST_SCHEMA, items: [{ ...PONDER, slug }] }));
      expect(error.code, slug).toBe("items_manifest_invalid");
    }
    for (const slug of ["a", "emote_ponder", "hat.red-2", "a".repeat(64)]) {
      expect(parseItemsManifest("/project", { schema: ITEMS_MANIFEST_SCHEMA, items: [{ ...PONDER, slug }] }).items[0].slug).toBe(slug);
    }
  });
});

const media: LocalMedia[] = [{ path: "art/emote_ponder.png", sha256: PNG_SHA, sizeBytes: PNG.length, kind: "IMAGE", contentType: "image/png" }];

function remote(overrides: { state?: string; revision?: Record<string, unknown>; priceSparks?: number | null; mediaSha256?: string[] } = {}): RemoteItem {
  return {
    definitionId: "item_ponder",
    state: overrides.state ?? "LIVE",
    slug: "emote_ponder",
    priceSparks: overrides.priceSparks === undefined ? 150 : overrides.priceSparks,
    mediaSha256: overrides.mediaSha256 ?? [PNG_SHA],
    revision: {
      revisionId: "rev_1",
      state: "PUBLISHED",
      presentation: { name: "Ponder", description: "Strike a thoughtful pose.", tags: ["emote"] },
      behavior: {
        class: "COSMETIC",
        ownershipMode: "INSTANCE",
        rights: { policy: "OWNED", consumable: false, directTransferAllowed: false, giftingAfterOwnershipAllowed: false, publicResalePolicyEligible: false },
        issuance: { serverMintAllowed: true, supportGrantAllowed: true },
        cosmetic: { familyId: "emote", variantKey: "ponder" },
      },
      supply: null,
      mediaAssetIds: ["asset_1"],
      ...overrides.revision,
    },
  };
}

describe("planItem", () => {
  it("creates an item the Game does not have under its slug", () => {
    expect(planItem(manifestItem(), media, null)).toMatchObject({ action: "create", slug: "emote_ponder" });
  });

  it("leaves an item that already matches alone", () => {
    expect(planItem(manifestItem(), media, remote())).toEqual({ slug: "emote_ponder", action: "unchanged", definitionId: "item_ponder" });
  });

  it("revises a released item in a new draft, and edits a draft in place", () => {
    const renamed = manifestItem({ name: "Deep Ponder", priceSparks: 200 });
    expect(planItem(renamed, media, remote())).toMatchObject({ action: "update", revision: "new_draft", changes: ["name", "price"] });
    expect(planItem(renamed, media, remote({ revision: { state: "DRAFT" } }))).toMatchObject({ action: "update", revision: "edit_draft" });
  });

  it("sees changed media by content, not by file name", () => {
    expect(planItem(manifestItem(), media, remote({ mediaSha256: ["0".repeat(64)] }))).toMatchObject({ action: "update", changes: ["media"] });
  });

  it("never plans a class or ownership mode change, which a revision cannot make", () => {
    const plan = planItem(manifestItem({ class: "STANDARD", cosmetic: undefined }), media, remote());
    expect(plan.action).toBe("blocked");
  });

  it("waits while Summer reviews the item", () => {
    const plan = planItem(manifestItem({ name: "Deep Ponder" }), media, remote({ revision: { state: "SUBMITTED" } }));
    expect(plan).toMatchObject({ action: "blocked" });
  });
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** The creator store proxy for one Game, with the platform's agent gate: item writes are refused. */
function fakeStore(options: { existing?: RemoteItem | null } = {}) {
  const calls: Call[] = [];
  let assetState = "PENDING_UPLOAD";
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, headers, body });
    if (url.startsWith("https://media.test/")) {
      assetState = "UPLOADED";
      return new Response(null, { status: 200 });
    }
    const existing = options.existing;
    if (method === "GET" && url.startsWith(`${STORE}/games/game-1/item-definitions?slug=`)) {
      return json(200, { items: existing ? [{ definitionId: existing.definitionId, slug: existing.slug, state: existing.state, authority: "CREATOR_CATALOG" }] : [] });
    }
    if (method === "GET" && url.startsWith(`${STORE}/games/game-1/item-definitions?limit=`)) {
      return json(200, { items: [{ definitionId: "item_old", slug: null, name: "Old hat", authority: "CREATOR_CATALOG" }] });
    }
    if (existing && method === "GET" && url === `${STORE}/games/game-1/item-definitions/${existing.definitionId}`) {
      return json(200, { definition: { definitionId: existing.definitionId, state: existing.state }, revision: { ...existing.revision, priceBookId: "pb_1" } });
    }
    if (existing && method === "GET" && url.endsWith("/price-book/diff")) return json(200, { priceBook: { baseSparksAmount: existing.priceSparks } });
    if (method === "GET" && url === `${STORE}/media-assets/asset_1`) return json(200, { assetId: "asset_1", sha256: existing?.mediaSha256[0] ?? "", state: "VERIFIED" });
    if (method === "POST" && url === `${STORE}/media-assets:begin-upload`) {
      return json(201, { assetId: "asset_new", uploadSessionId: "upload_1", method: "PUT", url: "https://media.test/asset_new", headers: { "Content-Type": "image/png" } });
    }
    if (method === "GET" && url === `${STORE}/media-assets/asset_new`) return json(200, { assetId: "asset_new", state: assetState, sha256: PNG_SHA });
    if (method === "POST" && url === `${STORE}/media-assets/asset_new:complete`) {
      assetState = "VERIFYING";
      return json(202, { assetId: "asset_new", state: "VERIFYING" });
    }
    if (method !== "GET" && url.includes("/item-definitions")) {
      return json(403, { error: { code: "owner_approval_required", message: "An agent cannot do this." } });
    }
    return json(404, { error: { code: "not_found" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

let root = "";
const savedGateway = process.env.SUMMER_GATEWAY_URL;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-sync-items-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_GATEWAY_URL = GATEWAY;
  await writeFile(join(root, "project.godot"), "[application]\n");
  await mkdir(join(root, "art"));
  await writeFile(join(root, "art", "emote_ponder.png"), PNG);
  await writeFile(join(root, "summer.items.json"), JSON.stringify({ schema: ITEMS_MANIFEST_SCHEMA, items: [PONDER] }));
});

afterEach(async () => {
  if (savedGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = savedGateway;
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

function deps(fetch: typeof globalThis.fetch, proposals: ProposeItemsRequest[]): Partial<SyncItemsDependencies> {
  return {
    fetch,
    token: async () => "agent-oauth-token",
    signedInResource: async () => null,
    propose: async (request) => {
      proposals.push(request);
      return { ok: true, status: "needs_approval", approval: { id: "apr_1", url: "https://staging.test/studio/grow/approvals/apr_1", who: "owner", summary: "Add 1 item" }, job: { id: "apr:1", state: "awaiting_approval" } };
    },
  };
}

describe("syncItems", () => {
  it("previews the plan for the configured gateway and changes nothing until confirmed", async () => {
    const store = fakeStore();
    const proposals: ProposeItemsRequest[] = [];
    const result = await syncItems({ gameId: "game-1", project: root, face: "cli" }, deps(store.fetch, proposals));
    expect(result).toMatchObject({ status: "confirmation_required", gateway: GATEWAY, gameId: "game-1" });
    expect((result.plan as Array<{ action: string }>).map((plan) => plan.action)).toEqual(["create"]);
    expect(result.notInManifest).toEqual([{ slug: null, definitionId: "item_old", name: "Old hat" }]);
    expect(store.calls.filter((call) => call.method !== "GET")).toEqual([]);
    expect(proposals).toEqual([]);
  });

  it("on confirm uploads the media and asks the owner, and never writes an item itself", async () => {
    const store = fakeStore();
    const proposals: ProposeItemsRequest[] = [];
    const result = await syncItems({ gameId: "game-1", project: root, confirm: true, face: "mcp" }, deps(store.fetch, proposals));
    expect(result).toMatchObject({ status: "awaiting_owner_approval", approval: { url: "https://staging.test/studio/grow/approvals/apr_1" } });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].items).toEqual([
      expect.objectContaining({ slug: "emote_ponder", action: "create", item: expect.objectContaining({ priceSparks: 150, mediaAssetIds: ["asset_new"] }) }),
    ]);
    const writes = store.calls.filter((call) => call.method !== "GET");
    expect(writes.some((call) => call.url.includes("/item-definitions"))).toBe(false);
    expect(writes.find((call) => call.url.endsWith("media-assets:begin-upload"))?.body).toMatchObject({ gameId: "game-1", kind: "IMAGE", contentType: "image/png", sha256: PNG_SHA });
    expect(writes.find((call) => call.url === "https://media.test/asset_new")).toBeDefined();
  });

  it("asks the owner once for the same plan, however often it is retried", async () => {
    const proposals: ProposeItemsRequest[] = [];
    await syncItems({ gameId: "game-1", project: root, confirm: true, face: "cli" }, deps(fakeStore().fetch, proposals));
    await syncItems({ gameId: "game-1", project: root, confirm: true, face: "cli" }, deps(fakeStore().fetch, proposals));
    expect(proposals[0].idempotencyKey).toBe(proposals[1].idempotencyKey);
  });

  it("names the item it revises and the revision the plan was made against", async () => {
    await writeFile(join(root, "summer.items.json"), JSON.stringify({ schema: ITEMS_MANIFEST_SCHEMA, items: [{ ...PONDER, priceSparks: 200 }] }));
    const store = fakeStore({ existing: remote() });
    const proposals: ProposeItemsRequest[] = [];
    await syncItems({ gameId: "game-1", project: root, confirm: true, face: "cli" }, deps(store.fetch, proposals));
    expect(proposals[0].items[0]).toMatchObject({ action: "update", definitionId: "item_ponder", basedOnRevisionId: "rev_1", item: { priceSparks: 200, mediaAssetIds: ["asset_new"] } });
  });

  it("sends nothing when the Game already matches", async () => {
    const store = fakeStore({ existing: remote() });
    const proposals: ProposeItemsRequest[] = [];
    const result = await syncItems({ gameId: "game-1", project: root, confirm: true, face: "cli" }, deps(store.fetch, proposals));
    expect(result.status).toBe("up_to_date");
    expect(proposals).toEqual([]);
    expect(store.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("stops before reading or sending when the sign-in is for the other environment", async () => {
    const saved = process.env.SUMMER_MCP_RESOURCE_URL;
    process.env.SUMMER_MCP_RESOURCE_URL = "https://mcp.staging.test/mcp";
    try {
      const store = fakeStore();
      const proposals: ProposeItemsRequest[] = [];
      const error = await failure(
        syncItems({ gameId: "game-1", project: root, confirm: true, face: "cli" }, { ...deps(store.fetch, proposals), signedInResource: async () => "https://mcp.summerengine.com/mcp" })
      );
      expect(error.code).toBe("store_login_other_environment");
      expect(error.recovery).toContain("summer login --store --force");
      expect(store.calls).toEqual([]);
      expect(proposals).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.SUMMER_MCP_RESOURCE_URL;
      else process.env.SUMMER_MCP_RESOURCE_URL = saved;
    }
  });

  it("refuses a slug the manifest does not have before reaching the store", async () => {
    const store = fakeStore();
    const error = await failure(syncItems({ gameId: "game-1", project: root, slugs: ["emote_wave"], face: "cli" }, deps(store.fetch, [])));
    expect(error.code).toBe("item_slug_unknown");
    expect(store.calls).toEqual([]);
  });
});
