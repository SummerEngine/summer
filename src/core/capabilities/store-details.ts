import { createHash } from "node:crypto";
import { resolveGatewayUrl } from "../config.js";
import { createStore, defaultDependencies, listGamesOrThrow, storeToken, type PublishBuildDependencies, type Store } from "./publish-build.js";
import { BuildToolError } from "./summer-bundle.js";

/**
 * summer_store_set_details: the store page sections the hosted
 * store.update_listing does not edit, on the store page draft:
 * genres, features, credits, language support, system requirements, the
 * content questionnaire (contentSurvey) and the AI disclosure. Same route as
 * Studio's store page editor:
 *
 *   GET   games/{g}/revisions          the newest revision
 *   POST  games/{g}/revisions          a new draft from it, when it is not a draft
 *   PATCH games/{g}/revisions/{r}      the sections, with the revision's ETag
 *
 * Each section given replaces that section; null clears it; an omitted one
 * keeps its value (summer-platform api/management/openapi.yaml,
 * PatchRevision and the store page section schemas). Saving never publishes.
 */

export const STORE_FEATURES = [
  "single_player",
  "online_multiplayer",
  "local_multiplayer",
  "online_coop",
  "local_coop",
  "cross_platform",
  "controller_full",
  "controller_partial",
  "cloud_saves",
  "plays_in_browser",
  "level_editor",
  "achievements",
  "in_game_purchases",
] as const;
export const AI_USES = ["assets", "code", "generatedGameplay"] as const;
export const SURVEY_LEVELS = {
  violence: ["none", "fantasy", "realistic"],
  bloodGore: ["none", "mild", "intense"],
  sexualContent: ["none", "suggestive", "explicit"],
  nudity: ["none", "partial", "full"],
  language: ["none", "mild", "strong"],
  substances: ["none", "referenced", "used"],
  gambling: ["none", "simulated", "realMoney"],
} as const;

export const DETAIL_SECTIONS = ["genres", "features", "credits", "languageSupport", "systemRequirements", "contentSurvey", "aiDisclosure"] as const;
type Section = (typeof DETAIL_SECTIONS)[number];

export type StoreDetailsInput = { gameId?: string; face: "cli" | "mcp" } & Partial<Record<Section, unknown>>;

const IN_REVIEW = ["SUBMITTED", "VERIFYING", "SCHEDULED"];
const seg = encodeURIComponent;

/** The store page refusals this tool can name before anything is sent. */
function checkSections(input: StoreDetailsInput): void {
  const ai = input.aiDisclosure as { uses?: string[]; description?: string } | null | undefined;
  if (ai && Array.isArray(ai.uses) && ai.uses.includes("generatedGameplay") && !ai.description?.trim()) {
    throw new BuildToolError(
      "ai_disclosure_incomplete",
      "aiDisclosure uses generatedGameplay, which needs a description of what is generated while people play and its guardrails.",
      "Recovery: add aiDisclosure.description, then call again."
    );
  }
}

async function editableDraft(store: Store, gameId: string, key: string): Promise<Record<string, any>> {
  const revisions = await store.call<{ items?: Array<Record<string, any>> }>("GET", `games/${seg(gameId)}/revisions?limit=20`);
  const newest = (revisions.items ?? []).reduce<Record<string, any> | null>((best, item) => (!best || Number(item.sequence ?? 0) > Number(best.sequence ?? 0) ? item : best), null);
  if (!newest) throw new BuildToolError("no_store_page", "This game has no store page yet.", "Recovery: create it with games.create, then call again.");
  if (newest.state === "DRAFT") return newest;
  if (IN_REVIEW.includes(newest.state)) {
    throw new BuildToolError(
      "page_publishing",
      "The store page is being published right now, so it cannot change until that finishes.",
      "Recovery: read summer_go_live (or store.status) for where it stands; once it is live, call this again to edit a new draft."
    );
  }
  return store.call<Record<string, any>>("POST", `games/${seg(gameId)}/revisions`, { body: {}, key });
}

export async function setStoreDetails(input: StoreDetailsInput, overrides: Partial<PublishBuildDependencies> = {}): Promise<Record<string, unknown> & { ok: true }> {
  const deps = { ...defaultDependencies, ...overrides };
  const gameId = input.gameId?.trim();
  if (!gameId) return listGamesOrThrow(deps);
  const patch = Object.fromEntries(DETAIL_SECTIONS.filter((section) => input[section] !== undefined).map((section) => [section, input[section]]));
  if (!Object.keys(patch).length) {
    throw new BuildToolError("nothing_to_change", "No store page section was given.", `Recovery: pass at least one of ${DETAIL_SECTIONS.join(", ")}.`);
  }
  checkSections(input);
  const store = createStore(await resolveGatewayUrl(), await storeToken(deps), deps);
  const key = (step: string) => createHash("sha256").update(`store-details:${gameId}:${step}:${JSON.stringify(patch)}`).digest("hex");
  const draft = await editableDraft(store, gameId, key("fork"));
  const saved = await store.call<Record<string, any>>("PATCH", `games/${seg(gameId)}/revisions/${seg(String(draft.revisionId))}`, {
    body: patch,
    key: key(`patch:${draft.revisionId}:${draft.etagRevision}`),
    headers: { "x-summer-revision": `"game-revision:${draft.revisionId}:${draft.etagRevision}"` },
  });
  return {
    ok: true,
    status: "saved",
    gameId,
    revisionId: saved.revisionId ?? draft.revisionId,
    state: saved.state ?? draft.state,
    saved: Object.fromEntries(Object.keys(patch).map((section) => [section, saved[section] ?? patch[section]])),
    next: "Saved on the store page draft; nothing is published. Read it with store.get_listing; take it live with summer_go_live.",
  };
}
