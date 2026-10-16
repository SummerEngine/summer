import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { BuildToolError } from "./summer-bundle.js";

/**
 * summer.items.json: the Game's items, keyed by creator slug, next to
 * summer.build.json in the project root and committed with the game.
 *
 * It names no Game, environment or platform id: the same file syncs to the
 * staging Game and to the production Game, and the slug (the creator key the
 * game's code uses, e.g. "emote_ponder") is what identifies an item in both.
 * The gameId comes with each sync call, as with summer_publish_build.
 *
 *   {
 *     "schema": "summer.items/v1",
 *     "items": [
 *       {
 *         "slug": "emote_ponder",
 *         "name": "Ponder",
 *         "description": "Strike a thoughtful pose.",
 *         "class": "COSMETIC",
 *         "cosmetic": { "familyId": "emote", "variantKey": "ponder" },
 *         "tags": ["emote"],
 *         "ownership": "OWNED",
 *         "priceSparks": 150,
 *         "media": ["art/items/emote_ponder.png"]
 *       }
 *     ]
 *   }
 *
 * The checks here are the platform's own create rules (management API
 * item-definitions), so a file that passes is not refused for its shape.
 */

export const ITEMS_MANIFEST_FILE = "summer.items.json";
export const ITEMS_MANIFEST_SCHEMA = "summer.items/v1";

/** The platform's slug rule: 1-64 characters, lowercase, words joined by one ".", "_" or "-". */
export const ITEM_SLUG = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;
const TAG = /^[a-z0-9][a-z0-9._-]{0,47}$/;
/** Cosmetic familyId and variantKey: the platform's compatibility value rule, at most 128 characters. */
const COSMETIC_KEY = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;
const BACKGROUND = /^#[0-9A-Fa-f]{6}$/;
const MAX_ITEMS = 500;
const MAX_MEDIA = 20;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 5000;
const MAX_TAGS = 20;

export const ITEM_CLASSES = ["STANDARD", "COSMETIC"] as const;
export const OWNERSHIP_MODES = ["INSTANCE", "QUANTITY"] as const;
export const OWNERSHIP_POLICIES = ["SOULBOUND", "OWNED", "MARKETABLE"] as const;

export const MEDIA_TYPES: Record<string, { kind: "IMAGE" | "MODEL_3D"; contentType: string; maxBytes: number }> = {
  ".png": { kind: "IMAGE", contentType: "image/png", maxBytes: 32 << 20 },
  ".jpg": { kind: "IMAGE", contentType: "image/jpeg", maxBytes: 32 << 20 },
  ".jpeg": { kind: "IMAGE", contentType: "image/jpeg", maxBytes: 32 << 20 },
  ".webp": { kind: "IMAGE", contentType: "image/webp", maxBytes: 32 << 20 },
  ".glb": { kind: "MODEL_3D", contentType: "model/gltf-binary", maxBytes: 64 << 20 },
};

export interface ManifestItem {
  slug: string;
  name: string;
  description: string;
  class: (typeof ITEM_CLASSES)[number];
  cosmetic?: { familyId: string; variantKey: string };
  tags: string[];
  ownershipMode: (typeof OWNERSHIP_MODES)[number];
  maxOwned?: number;
  ownership: (typeof OWNERSHIP_POLICIES)[number];
  consumable: boolean;
  /** Lifetime mint limit; absent is unlimited. */
  supply?: number;
  /** Base price in Sparks. Absent: this file sets no price (a new item is not sold; an existing price stays). */
  priceSparks?: number;
  backgroundColor?: string;
  /** Project-relative paths, in store order. */
  media: string[];
}

export interface ItemsManifest {
  path: string;
  project: string;
  items: ManifestItem[];
}

/** The platform behavior a manifest entry declares (item-definitions create body). */
export function behaviorOf(item: ManifestItem) {
  const marketable = item.ownership === "MARKETABLE";
  return {
    class: item.class,
    ownershipMode: item.ownershipMode,
    ...(item.maxOwned !== undefined ? { maxOwned: item.maxOwned } : {}),
    rights: {
      policy: item.ownership,
      consumable: item.consumable,
      directTransferAllowed: marketable,
      giftingAfterOwnershipAllowed: marketable,
      publicResalePolicyEligible: marketable,
    },
    // Studio's defaults: the game's server may grant it, and Summer support may restore it.
    issuance: { serverMintAllowed: true, supportGrantAllowed: true },
    ...(item.cosmetic ? { cosmetic: item.cosmetic } : {}),
  };
}

class ManifestProblems {
  readonly list: string[] = [];
  add(where: string, problem: string) {
    if (this.list.length < 50) this.list.push(`${where}: ${problem}`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveInt = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const ITEM_FIELDS = new Set([
  "slug", "name", "description", "class", "cosmetic", "tags", "ownershipMode", "maxOwned",
  "ownership", "consumable", "supply", "priceSparks", "backgroundColor", "media",
]);

function mediaPath(project: string, value: unknown, where: string, problems: ManifestProblems): string | null {
  if (typeof value !== "string" || !value.trim()) {
    problems.add(where, "a project-relative file path");
    return null;
  }
  const clean = normalize(value.trim());
  const full = resolve(project, clean);
  const inside = relative(project, full);
  if (isAbsolute(value) || inside.startsWith("..") || isAbsolute(inside)) {
    problems.add(where, `"${value}" is outside the project; use a path inside it`);
    return null;
  }
  if (!MEDIA_TYPES[extname(clean).toLowerCase()]) {
    problems.add(where, `"${value}" is not a store image (.png, .jpg, .webp) or model (.glb)`);
    return null;
  }
  return inside.split(sep).join("/");
}

function readItem(project: string, raw: unknown, index: number, problems: ManifestProblems): ManifestItem | null {
  const at = `items[${index}]`;
  if (!isObject(raw)) {
    problems.add(at, "an object");
    return null;
  }
  const where = typeof raw.slug === "string" ? `${at} (${raw.slug})` : at;
  for (const key of Object.keys(raw)) if (!ITEM_FIELDS.has(key)) problems.add(where, `unknown field "${key}"`);
  const before = problems.list.length;

  const slug = raw.slug;
  if (typeof slug !== "string" || slug.length > 64 || !ITEM_SLUG.test(slug)) {
    problems.add(where, 'slug: 1-64 lowercase letters and digits, words joined by ".", "_" or "-", starting with a letter (e.g. "emote_ponder")');
  }
  const name = raw.name;
  if (typeof name !== "string" || name !== name.trim() || name.length < 1 || [...name].length > MAX_NAME) {
    problems.add(where, `name: 1-${MAX_NAME} characters, no surrounding spaces`);
  }
  const description = raw.description;
  if (typeof description !== "string" || description !== description.trim() || description.length < 1 || [...description].length > MAX_DESCRIPTION) {
    problems.add(where, `description: 1-${MAX_DESCRIPTION} characters, no surrounding spaces`);
  }
  const itemClass = raw.class ?? "STANDARD";
  if (!ITEM_CLASSES.includes(itemClass as never)) problems.add(where, `class: one of ${ITEM_CLASSES.join(", ")}`);
  const ownershipMode = raw.ownershipMode ?? "INSTANCE";
  if (!OWNERSHIP_MODES.includes(ownershipMode as never)) problems.add(where, `ownershipMode: one of ${OWNERSHIP_MODES.join(", ")}`);
  const ownership = raw.ownership ?? "OWNED";
  if (!OWNERSHIP_POLICIES.includes(ownership as never)) problems.add(where, `ownership: one of ${OWNERSHIP_POLICIES.join(", ")}`);
  if (raw.consumable !== undefined && typeof raw.consumable !== "boolean") problems.add(where, "consumable: true or false");
  if (raw.maxOwned !== undefined && !positiveInt(raw.maxOwned)) problems.add(where, "maxOwned: a whole number, 1 or more");
  if (raw.supply !== undefined && !positiveInt(raw.supply)) problems.add(where, "supply: a whole number, 1 or more (omit it for unlimited)");
  if (raw.priceSparks !== undefined && !positiveInt(raw.priceSparks)) problems.add(where, "priceSparks: a whole number of Sparks, 1 or more (omit it to set no price)");
  if (raw.backgroundColor !== undefined && (typeof raw.backgroundColor !== "string" || !BACKGROUND.test(raw.backgroundColor))) {
    problems.add(where, 'backgroundColor: "#RRGGBB"');
  }

  const tags = raw.tags ?? [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS || tags.some((tag) => typeof tag !== "string" || !TAG.test(tag)) || new Set(tags).size !== tags.length) {
    problems.add(where, `tags: up to ${MAX_TAGS} different lowercase tags (letters, digits, ".", "_", "-")`);
  }

  let cosmetic: ManifestItem["cosmetic"];
  if (itemClass === "COSMETIC") {
    const facet = raw.cosmetic;
    if (!isObject(facet) || typeof facet.familyId !== "string" || typeof facet.variantKey !== "string" || facet.familyId.length > 128 || facet.variantKey.length > 128 || !COSMETIC_KEY.test(facet.familyId) || !COSMETIC_KEY.test(facet.variantKey)) {
      problems.add(where, 'cosmetic: { "familyId": ..., "variantKey": ... }, each lowercase words joined by ".", "_" or "-", at most 128 characters');
    } else {
      cosmetic = { familyId: facet.familyId, variantKey: facet.variantKey };
    }
    if (ownershipMode === "QUANTITY" && raw.maxOwned !== 1) problems.add(where, "a COSMETIC with ownershipMode QUANTITY needs maxOwned 1");
  } else if (raw.cosmetic !== undefined) {
    problems.add(where, "cosmetic: only for class COSMETIC");
  }
  const mediaRaw = raw.media ?? [];
  const media: string[] = [];
  if (!Array.isArray(mediaRaw) || mediaRaw.length > MAX_MEDIA) {
    problems.add(where, `media: up to ${MAX_MEDIA} project-relative image or model paths`);
  } else {
    mediaRaw.forEach((value, mediaIndex) => {
      const path = mediaPath(project, value, `${where} media[${mediaIndex}]`, problems);
      if (path && media.includes(path)) problems.add(`${where} media[${mediaIndex}]`, `"${value}" is listed twice`);
      else if (path) media.push(path);
    });
  }

  if (problems.list.length !== before) return null;
  return {
    slug: slug as string,
    name: name as string,
    description: description as string,
    class: itemClass as ManifestItem["class"],
    ...(cosmetic ? { cosmetic } : {}),
    tags: tags as string[],
    ownershipMode: ownershipMode as ManifestItem["ownershipMode"],
    ...(raw.maxOwned !== undefined ? { maxOwned: raw.maxOwned as number } : {}),
    ownership: ownership as ManifestItem["ownership"],
    consumable: raw.consumable === true,
    ...(raw.supply !== undefined ? { supply: raw.supply as number } : {}),
    ...(raw.priceSparks !== undefined ? { priceSparks: raw.priceSparks as number } : {}),
    ...(raw.backgroundColor !== undefined ? { backgroundColor: raw.backgroundColor as string } : {}),
    media,
  };
}

/** Parse and check a manifest document; every problem is reported at once. */
export function parseItemsManifest(project: string, document: unknown, path = join(project, ITEMS_MANIFEST_FILE)): ItemsManifest {
  const problems = new ManifestProblems();
  if (!isObject(document)) problems.add(ITEMS_MANIFEST_FILE, "a JSON object");
  else {
    if (document.schema !== ITEMS_MANIFEST_SCHEMA) problems.add("schema", `"${ITEMS_MANIFEST_SCHEMA}"`);
    for (const key of Object.keys(document)) if (key !== "schema" && key !== "items") problems.add(ITEMS_MANIFEST_FILE, `unknown field "${key}"`);
    if (!Array.isArray(document.items) || document.items.length > MAX_ITEMS) problems.add("items", `a list of up to ${MAX_ITEMS} items`);
  }
  const rawItems = isObject(document) && Array.isArray(document.items) ? document.items : [];
  const items = rawItems.map((raw, index) => readItem(project, raw, index, problems));
  const seen = new Set<string>();
  for (const item of items) {
    if (!item) continue;
    if (seen.has(item.slug)) problems.add(`items (${item.slug})`, "the same slug is used twice; each item needs its own");
    seen.add(item.slug);
  }
  if (problems.list.length) {
    throw new BuildToolError(
      "items_manifest_invalid",
      `${ITEMS_MANIFEST_FILE} has ${problems.list.length === 50 ? "50 or more" : problems.list.length} problem${problems.list.length === 1 ? "" : "s"}. Nothing was sent.`,
      "Recovery: fix each listed field and call again.",
      undefined,
      { problems: problems.list, path }
    );
  }
  return { path, project, items: items as ManifestItem[] };
}

export async function readItemsManifest(project: string, file?: string): Promise<ItemsManifest> {
  const path = file ? resolve(project, file) : join(project, ITEMS_MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new BuildToolError(
      "items_manifest_missing",
      `There is no ${ITEMS_MANIFEST_FILE} at ${path}.`,
      `Recovery: write ${ITEMS_MANIFEST_FILE} in the project root ({"schema": "${ITEMS_MANIFEST_SCHEMA}", "items": [...]}), then call again.`
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new BuildToolError("items_manifest_invalid", `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`, "Recovery: fix the JSON and call again.");
  }
  return parseItemsManifest(project, document, path);
}
