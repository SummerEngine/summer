import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { resolveGatewayUrl } from "../config.js";
import { readStoredOAuthToken, resolveMcpResourceUrl } from "../oauth.js";
import { appendStoreJsonLine } from "../store.js";
import { resolveExportProject } from "./export-game.js";
import { behaviorOf, MEDIA_TYPES, readItemsManifest, type ManifestItem } from "./item-manifest.js";
import { createStore, defaultDependencies as publishDefaults, listGamesOrThrow, storeToken, type PublishBuildDependencies, type Store } from "./publish-build.js";
import { BuildToolError } from "./summer-bundle.js";

/**
 * summer_sync_items: bring a Game's items in line with summer.items.json,
 * matched by creator slug, so the same file gives the staging Game and the
 * production Game the same items (each Game keeps its own definition ids).
 *
 * Through the creator store proxy Studio uses (PSE /api/creator-store/* ->
 * /v1/management/*), with the store sign-in from "summer login --store":
 *
 *   GET  games/{g}/item-definitions?slug=           the item with this slug, or none
 *   GET  games/{g}/item-definitions/{d}             its latest revision (presentation, behavior, media)
 *   GET  .../revisions/{r}/price-book/diff          its Sparks price
 *   GET  media-assets/{a}                           the sha256 of each image it shows
 *   POST media-assets:begin-upload, PUT, :complete  only the images that changed (confirm=true)
 *
 * That sign-in is a delegated agent credential: the platform lets it read and
 * upload media, and refuses every item write with owner_approval_required
 * (agent_gate.go). So this tool never writes an item. With confirm=true it
 * uploads the changed images and asks the owner to apply the plan (the hosted
 * economy.propose_items operation): the owner approves in Studio, and Studio
 * creates or revises each item by slug, sets its price and submits it for
 * review with the owner's own session. Nothing here activates or publishes an
 * item; players see it only after Summer's review and the owner's release.
 *
 * Runs against the gateway the CLI is set to (SUMMER_GATEWAY_URL or
 * "summer config set gateway.url"), so staging and production differ only in
 * that setting, the hosted MCP (SUMMER_MCP_RESOURCE_URL), the store sign-in
 * and the gameId. The machine keeps one store sign-in: after switching
 * between staging and production, "summer login --store --force" signs in to
 * the other one. A sign-in for another hosted MCP stops the call up front.
 */

const seg = encodeURIComponent;
const MAX_PAGES = 20;
/** The most items one owner approval may carry (economy.propose_items). */
export const MAX_ITEMS_PER_PROPOSAL = 50;
/** Revisions a change may still be written into; the others get a new draft first. */
const EDITABLE = new Set(["DRAFT", "CHANGES_REQUESTED"]);
/** Revisions Summer is reviewing: a change waits until the review is decided. */
const IN_REVIEW = new Set(["SUBMITTED", "VERIFYING"]);

export interface SyncItemsInput {
  gameId?: string;
  project?: string;
  /** The manifest, relative to the project. Defaults to summer.items.json. */
  file?: string;
  /** Only these slugs; the rest of the manifest is left out of the plan. */
  slugs?: string[];
  confirm?: boolean;
  face: "cli" | "mcp";
}

/** What the owner is asked to apply: the manifest entry plus the media it now names. */
export interface ProposedItem {
  slug: string;
  action: "create" | "update";
  definitionId?: string;
  /** The revision the plan was made against; the owner's apply refuses if it moved on. */
  basedOnRevisionId?: string;
  item: Omit<ManifestItem, "media"> & { mediaAssetIds: string[] };
}

export interface ProposeItemsRequest {
  gameId: string;
  items: ProposedItem[];
  idempotencyKey: string;
}

/** Why economy.propose_items did not take the plan, in plain words, and what to do. */
const PROPOSAL_FAILURES: Record<string, string> = {
  invalid_input: "Recovery: Summer refused a field of the plan (details name it). Fix summer.items.json and call again; the uploaded media is reused.",
  idempotency_conflict: "Recovery: this plan's key was already used for a different plan. Call again with confirm=false to read the Game afresh, then confirm the new plan.",
  unavailable: "Recovery: Summer could not take the plan right now. Call again in a few minutes with the same summer.items.json; the owner is asked once.",
  not_found: "Recovery: Summer found no such game for this account on this gateway. Check gameId with games.list (staging and production games have different ids).",
};

export interface SyncItemsDependencies extends PublishBuildDependencies {
  readFile: (path: string) => Promise<Buffer>;
  /** Ask the owner to apply the plan (the hosted economy.propose_items). */
  propose: (request: ProposeItemsRequest) => Promise<Record<string, unknown>>;
  /** The hosted MCP this machine's store sign-in was made for, or null without one. */
  signedInResource: () => Promise<string | null>;
}

async function proposeOnHosted(request: ProposeItemsRequest): Promise<Record<string, unknown>> {
  // Loaded on use: the operation catalog imports the capabilities this file sits next to.
  const { answerOfHosted, callHostedV4 } = await import("../ops/cloud.js");
  const { idempotencyKey, ...input } = request;
  return answerOfHosted(await callHostedV4("summer_call", { op: "economy.propose_items", input: { ...input, idempotencyKey } })) as Record<string, unknown>;
}

export const syncItemsDefaults: SyncItemsDependencies = {
  ...publishDefaults,
  readFile: (path) => readFile(path),
  propose: proposeOnHosted,
  signedInResource: async () => (await readStoredOAuthToken())?.resource ?? null,
};

/**
 * The one store sign-in is for one hosted MCP. When SUMMER_MCP_RESOURCE_URL
 * now names another (staging after production, or back), the store refuses
 * the sign-in or the plan would reach the other environment: stop before
 * anything is read or sent.
 */
async function requireSignInForThisEnvironment(deps: SyncItemsDependencies): Promise<void> {
  const signedIn = await deps.signedInResource();
  const current = resolveMcpResourceUrl();
  if (signedIn && signedIn !== current) {
    throw new BuildToolError(
      "store_login_other_environment",
      `This machine's store sign-in is for ${signedIn}, but SUMMER_MCP_RESOURCE_URL is ${current}. Nothing was read or sent.`,
      'Recovery: switching between staging and production takes both SUMMER_GATEWAY_URL and SUMMER_MCP_RESOURCE_URL, then "summer login --store --force" to sign in to that environment; call again after it.',
      undefined,
      { signedInResource: signedIn, resource: current }
    );
  }
}

type Json = Record<string, any>;

export interface LocalMedia {
  path: string;
  sha256: string;
  sizeBytes: number;
  kind: "IMAGE" | "MODEL_3D";
  contentType: string;
}

export interface RemoteItem {
  definitionId: string;
  /** Who manages the item: CREATOR_CATALOG (the creator's store items) or PASSPORT_CONTROL (a Passport collectible). */
  authority?: string | null;
  state: string | null;
  slug: string;
  revision: Json;
  priceSparks: number | null;
  mediaSha256: string[];
}

export type ItemPlan =
  | { slug: string; action: "create"; changes: string[] }
  | { slug: string; action: "update"; definitionId: string; revisionId: string; revision: "edit_draft" | "new_draft"; changes: string[]; warnings?: string[] }
  | { slug: string; action: "unchanged"; definitionId: string }
  | { slug: string; action: "blocked"; definitionId?: string; reason: string };

const sameList = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * The plan for one manifest item against what the Game has under its slug.
 * Pure: the same inputs always give the same plan.
 */
export function planItem(item: ManifestItem, media: LocalMedia[], remote: RemoteItem | null): ItemPlan {
  const wanted = behaviorOf(item);
  if (!remote) {
    // The platform refuses an item created without media.
    if (!media.length) return { slug: item.slug, action: "blocked", reason: "a new item needs at least one image" };
    return { slug: item.slug, action: "create", changes: ["new item", ...(item.priceSparks !== undefined ? ["price"] : []), "media"] };
  }
  // A Passport collectible has its own lifecycle (Passport control, take-down), and the owner's apply only writes store items.
  if (remote.authority === "PASSPORT_CONTROL") {
    return {
      slug: item.slug,
      action: "blocked",
      definitionId: remote.definitionId,
      reason: `The Game's "${item.slug}" is a Passport collectible, which summer.items.json does not manage. Give this item another slug, or change the Passport item in Studio.`,
    };
  }
  const revision = remote.revision;
  if (typeof revision.revisionId !== "string" || !revision.revisionId) {
    return { slug: item.slug, action: "blocked", definitionId: remote.definitionId, reason: `Summer did not say which revision "${item.slug}" is on. Call again in a minute.` };
  }
  const behavior: Json = revision.behavior ?? {};
  // Class and ownership mode belong to the definition: a revision cannot change them.
  if (behavior.class !== wanted.class || behavior.ownershipMode !== wanted.ownershipMode) {
    return {
      slug: item.slug,
      action: "blocked",
      definitionId: remote.definitionId,
      reason: `The Game's "${item.slug}" is ${behavior.class} ${behavior.ownershipMode}; summer.items.json says ${wanted.class} ${wanted.ownershipMode}. Class and ownership mode cannot change: keep them, or give the new item a new slug.`,
    };
  }
  const presentation: Json = revision.presentation ?? {};
  const changes: string[] = [];
  if (presentation.name !== item.name) changes.push("name");
  if (presentation.description !== item.description) changes.push("description");
  if (!sameList(presentation.tags ?? [], item.tags)) changes.push("tags");
  if ((presentation.backgroundColor ?? undefined) !== item.backgroundColor) changes.push("backgroundColor");
  const rights: Json = behavior.rights ?? {};
  const ownershipChanged =
    (behavior.maxOwned ?? undefined) !== wanted.maxOwned ||
    rights.policy !== wanted.rights.policy ||
    rights.consumable !== wanted.rights.consumable ||
    rights.directTransferAllowed !== wanted.rights.directTransferAllowed ||
    rights.giftingAfterOwnershipAllowed !== wanted.rights.giftingAfterOwnershipAllowed ||
    rights.publicResalePolicyEligible !== wanted.rights.publicResalePolicyEligible ||
    JSON.stringify(behavior.cosmetic ?? null) !== JSON.stringify(wanted.cosmetic ?? null);
  if (ownershipChanged) changes.push("ownership rules");
  if ((revision.supply ?? undefined) !== item.supply) changes.push("supply");
  if (!sameList(remote.mediaSha256, media.map((file) => file.sha256))) changes.push("media");
  // No priceSparks leaves the item's price as it is (a price book cannot be removed).
  if (item.priceSparks !== undefined && remote.priceSparks !== item.priceSparks) changes.push("price");
  if (!changes.length) return { slug: item.slug, action: "unchanged", definitionId: remote.definitionId };
  const state = String(revision.state ?? "");
  if (IN_REVIEW.has(state)) {
    return { slug: item.slug, action: "blocked", definitionId: remote.definitionId, reason: `Summer is reviewing "${item.slug}" (${state}); its changes (${changes.join(", ")}) wait until the review is decided. Call again then.` };
  }
  const live = remote.state === "LIVE";
  return {
    slug: item.slug,
    action: "update",
    definitionId: remote.definitionId,
    revisionId: String(revision.revisionId),
    revision: EDITABLE.has(state) ? "edit_draft" : "new_draft",
    changes,
    ...(live && ownershipChanged ? { warnings: [`"${item.slug}" is live: new ownership rules apply to copies players get after the new revision is released.`] } : {}),
  };
}

async function hashMedia(project: string, path: string, deps: SyncItemsDependencies): Promise<LocalMedia> {
  const type = MEDIA_TYPES[extname(path).toLowerCase()]!;
  let bytes: Buffer;
  try {
    bytes = await deps.readFile(join(project, path));
  } catch {
    throw new BuildToolError("item_media_missing", `${path} (named in summer.items.json) is not in the project.`, "Recovery: add the file or fix its path, then call again.");
  }
  if (bytes.length === 0 || bytes.length > type.maxBytes) {
    throw new BuildToolError("item_media_too_large", `${path} is ${bytes.length} bytes; the store takes 1 to ${type.maxBytes} bytes for this kind.`, "Recovery: export a smaller file and call again.");
  }
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, kind: type.kind, contentType: type.contentType };
}

/** The Game's item with this slug (0 or 1), its latest revision, price and media digests. */
async function readRemote(store: Store, gameId: string, slug: string): Promise<RemoteItem | null> {
  const page = await store.call<{ items?: Json[] }>("GET", `games/${seg(gameId)}/item-definitions?slug=${seg(slug)}`);
  const found = (page.items ?? []).find((definition) => definition.slug === slug);
  if (!found) return null;
  const definitionId = String(found.definitionId);
  // A Passport collectible is blocked by its authority alone (planItem): nothing else of it is read.
  if (found.authority === "PASSPORT_CONTROL") {
    return { definitionId, authority: "PASSPORT_CONTROL", state: typeof found.state === "string" ? found.state : null, slug, revision: {}, priceSparks: null, mediaSha256: [] };
  }
  const current = await store.call<Json>("GET", `games/${seg(gameId)}/item-definitions/${seg(definitionId)}`);
  const revision: Json = current.revision ?? {};
  let priceSparks: number | null = null;
  if (revision.priceBookId) {
    const diff = await store.call<Json>("GET", `games/${seg(gameId)}/item-definitions/${seg(definitionId)}/revisions/${seg(String(revision.revisionId))}/price-book/diff`);
    priceSparks = typeof diff.priceBook?.baseSparksAmount === "number" ? diff.priceBook.baseSparksAmount : null;
  }
  const mediaSha256: string[] = [];
  for (const assetId of (revision.mediaAssetIds ?? []) as string[]) {
    const asset = await store.call<Json>("GET", `media-assets/${seg(assetId)}`);
    mediaSha256.push(String(asset.sha256 ?? ""));
  }
  const authority = typeof current.definition?.authority === "string" ? current.definition.authority : typeof found.authority === "string" ? found.authority : null;
  return { definitionId, authority, state: typeof current.definition?.state === "string" ? current.definition.state : null, slug, revision, priceSparks, mediaSha256 };
}

/** Upload one file as a Game media asset; the same file and name continue the same upload. */
async function uploadMedia(store: Store, gameId: string, file: LocalMedia, project: string, deps: SyncItemsDependencies): Promise<string> {
  const originalFilename = basename(file.path);
  const key = (step: string) => createHash("sha256").update(`${gameId}:${file.sha256}:${originalFilename}:item-media:${step}`).digest("hex");
  const contract = await store.call<Json>("POST", "media-assets:begin-upload", {
    key: key("begin"),
    body: { gameId, kind: file.kind, contentType: file.contentType, byteLength: file.sizeBytes, sha256: file.sha256, originalFilename },
  });
  const assetId = String(contract.assetId ?? "");
  if (!assetId || !contract.uploadSessionId) throw new BuildToolError("store_invalid_response", "The store did not return a media upload.", "Recovery: retry; the same upload continues.");
  const asset = await store.call<Json>("GET", `media-assets/${seg(assetId)}`);
  if (asset.state === "PENDING_UPLOAD") {
    if (Array.isArray(contract.parts) && contract.parts.length) {
      throw new BuildToolError("item_media_too_large", `${file.path} needs a multipart upload, which this tool does not do.`, "Recovery: use a smaller file, or upload it in Studio.");
    }
    const response = await deps.fetch(String(contract.url), {
      method: String(contract.method ?? "PUT"),
      headers: contract.headers ?? {},
      body: new Uint8Array(await deps.readFile(join(project, file.path))),
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok && response.status !== 412) {
      throw new BuildToolError("item_media_upload_failed", `${file.path} did not upload (${response.status}).`, "Recovery: call again; the same upload continues.");
    }
  }
  if (asset.state === "PENDING_UPLOAD" || asset.state === "UPLOADED") {
    await store.call("POST", `media-assets/${seg(assetId)}:complete`, { key: key("complete"), body: { uploadSessionId: contract.uploadSessionId } });
  }
  if (asset.state === "REJECTED" || asset.state === "EXPIRED") {
    throw new BuildToolError("item_media_refused", `Summer did not keep ${file.path} (${asset.state}).`, "Recovery: check the image (not blank, a real PNG, JPEG or WebP) and call again.");
  }
  return assetId;
}

export type SyncItemsResult = Record<string, unknown> & { ok: true; status: string };

export async function syncItems(input: SyncItemsInput, overrides: Partial<SyncItemsDependencies> = {}): Promise<SyncItemsResult> {
  const deps = { ...syncItemsDefaults, ...overrides };
  const project = resolveExportProject(input.project);
  const manifest = await readItemsManifest(project, input.file);
  const only = input.slugs?.length ? new Set(input.slugs) : null;
  const unknown = only ? [...only].filter((slug) => !manifest.items.some((item) => item.slug === slug)) : [];
  if (unknown.length) {
    throw new BuildToolError("item_slug_unknown", `summer.items.json has no item ${unknown.map((slug) => `"${slug}"`).join(", ")}.`, "Recovery: pass slugs from summer.items.json, or add the items there first.");
  }
  const items = manifest.items.filter((item) => !only || only.has(item.slug));
  const gameId = input.gameId?.trim();
  if (!gameId) return listGamesOrThrow(deps);

  await requireSignInForThisEnvironment(deps);
  const gateway = await resolveGatewayUrl();
  const store = createStore(gateway, await storeToken(deps), deps);
  const media = new Map<string, LocalMedia[]>();
  const remote = new Map<string, RemoteItem | null>();
  const plans: ItemPlan[] = [];
  for (const item of items) {
    const files = await Promise.all(item.media.map((path) => hashMedia(project, path, deps)));
    media.set(item.slug, files);
    const found = await readRemote(store, gameId, item.slug);
    remote.set(item.slug, found);
    plans.push(planItem(item, files, found));
  }
  const notInManifest = await listUnmanaged(store, gameId, new Set(manifest.items.map((item) => item.slug)));
  // Sorted by slug: the same file always gives the same proposal and the same batches.
  const pending = plans.filter((plan) => plan.action === "create" || plan.action === "update").sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const blocked = plans.filter((plan) => plan.action === "blocked");
  const batches = Array.from({ length: Math.ceil(pending.length / MAX_ITEMS_PER_PROPOSAL) }, (_, index) =>
    pending.slice(index * MAX_ITEMS_PER_PROPOSAL, (index + 1) * MAX_ITEMS_PER_PROPOSAL).map((plan) => plan.slug)
  );
  const warnings = [
    ...plans.flatMap((plan) => (plan.action === "update" && plan.warnings) || []),
    ...(batches.length > 1 ? [`${pending.length} items change, and one owner approval takes at most ${MAX_ITEMS_PER_PROPOSAL}: confirm them in ${batches.length} calls, each with slugs from one of batches.`] : []),
  ];
  const summary = {
    gateway,
    gameId,
    manifest: manifest.path,
    plan: plans,
    ...(notInManifest.length ? { notInManifest } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(batches.length > 1 ? { batches } : {}),
  };

  if (input.confirm !== true || !pending.length) {
    return {
      ok: true,
      status: pending.length ? "confirmation_required" : "up_to_date",
      ...summary,
      next: pending.length
        ? `Show the user this plan for ${gateway} (game ${gameId}): ${pending.length} item(s) to create or change${blocked.length ? `, ${blocked.length} blocked` : ""}. Only after they approve, call again with confirm=true: it uploads the changed media and sends the plan to the game's owner, who approves it in Studio. Nothing was uploaded or changed.`
        : blocked.length
          ? "Nothing can change now: read each blocked item's reason."
          : "The Game's items already match summer.items.json.",
    };
  }

  if (batches.length > 1) {
    throw new BuildToolError(
      "item_plan_too_large",
      `${pending.length} items would change, and one owner approval takes at most ${MAX_ITEMS_PER_PROPOSAL}. Nothing was uploaded or sent.`,
      `Recovery: call again with confirm=true and slugs set to one batch at a time (batches lists them, ${MAX_ITEMS_PER_PROPOSAL} per batch, by slug); each batch gets its own approval link.`,
      undefined,
      { batches }
    );
  }

  const audit = { at: new Date(deps.now()).toISOString(), operation: "sync_items", face: input.face, gateway, gameId, slugs: pending.map((plan) => plan.slug) };
  await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "started" });
  try {
    const proposed: ProposedItem[] = [];
    for (const plan of pending) {
      const item = items.find((candidate) => candidate.slug === plan.slug)!;
      const mediaAssetIds: string[] = [];
      for (const file of media.get(item.slug) ?? []) mediaAssetIds.push(await uploadMedia(store, gameId, file, project, deps));
      const { media: _paths, ...declared } = item;
      proposed.push({
        slug: item.slug,
        action: plan.action as "create" | "update",
        ...(plan.action === "update" ? { definitionId: plan.definitionId, basedOnRevisionId: plan.revisionId } : {}),
        item: { ...declared, mediaAssetIds },
      });
    }
    // One request per exact plan: a retry asks the owner once, not twice.
    const idempotencyKey = createHash("sha256").update(JSON.stringify({ gameId, proposed })).digest("hex").slice(0, 64);
    const answer = await deps.propose({ gameId, items: proposed, idempotencyKey });
    await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: String(answer.status ?? (answer.ok === false ? "failed" : "sent")) });
    if (answer.ok === false) {
      const error = (answer.error ?? {}) as Json;
      const code = String(error.code ?? "items_proposal_failed");
      throw new BuildToolError(
        code,
        `${String(error.message ?? "Summer did not take the item plan.").replace(/\.?$/, ".")} Nothing changed.`,
        PROPOSAL_FAILURES[code] ?? "Recovery: the media is uploaded; call again with the same summer.items.json to send the same plan.",
        undefined,
        { ...(error.details ? { details: error.details } : {}), ...(error.requestId ? { requestId: error.requestId } : {}) }
      );
    }
    return {
      ok: true,
      status: answer.status === "needs_approval" ? "awaiting_owner_approval" : String(answer.status ?? "sent"),
      ...summary,
      ...(answer.approval ? { approval: answer.approval } : {}),
      next: "Give the owner the approval link. Nothing changes until they approve in Studio; then each item is submitted for Summer's review. Call again later to see the result.",
    };
  } catch (error) {
    await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "failed", code: error instanceof BuildToolError ? error.code : "sync_items_failed" });
    throw error;
  }
}

/** Slugged items the Game has that summer.items.json does not name: listed, never changed. */
async function listUnmanaged(store: Store, gameId: string, named: Set<string>): Promise<Array<{ slug: string | null; definitionId: string; name: string | null }>> {
  const out: Array<{ slug: string | null; definitionId: string; name: string | null }> = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await store.call<{ items?: Json[]; nextCursor?: string }>("GET", `games/${seg(gameId)}/item-definitions?limit=100${cursor ? `&cursor=${seg(cursor)}` : ""}`);
    for (const definition of body.items ?? []) {
      if (definition.authority === "PASSPORT_CONTROL") continue;
      const slug = typeof definition.slug === "string" ? definition.slug : null;
      if (!slug || !named.has(slug)) out.push({ slug, definitionId: String(definition.definitionId), name: typeof definition.name === "string" ? definition.name : null });
    }
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return out;
}
