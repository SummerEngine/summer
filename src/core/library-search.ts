/**
 * Library search — the runtime librarian's first half (CONTRACT §6, §9).
 *
 * `searchLibrary(query, options)` ranks every entry of the shipped
 * registry/generated/index.json for a plain-language task:
 *
 *   1. LEXICAL — `rankEntries` from ./registry-search.ts, the SAME kind-aware
 *      BM25 ranker the routing eval gates on, so runtime search and the eval
 *      measure one ranking.
 *   2. SEMANTIC (optional) — when the install ships
 *      registry/generated/embeddings.json AND a query-embedding provider
 *      answers (SUMMER_EMBED_URL, or <gateway>/api/mcp/embed; 1.5s timeout;
 *      Summer account token attached when logged in), the query is embedded
 *      and scored by cosine over every stored vector (brute force — 10k x 384
 *      floats is well under a millisecond of arithmetic).
 *   3. FUSION — lexical and semantic rankings merge by reciprocal rank fusion
 *      (k = 60). `matched_by` tells the agent which side found each hit.
 *
 * Offline, no embeddings file, provider error, dims mismatch, unparsable
 * file: lexical only, `matched_by: ["lexical"]`, never a throw for that
 * reason. Ties break on id so output is stable across runs.
 *
 * One behavior, two faces: `runSearchLibrary` is what both
 * src/mcp/tools/library-tools.ts (summer_search_library) and
 * src/core/capabilities/tool-dispatch.ts (`summer tool search-library`) call.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getAuthToken } from "./auth.js";
import { resolveGatewayUrl } from "./config.js";
import {
  EMBED_PATH,
  EMBEDDINGS_FILE,
  cosineSimilarity,
  createEmbedProvider,
  decodeVector,
  parseEmbeddingsFile,
  reciprocalRankFusion,
  type EmbeddingsFile,
} from "./embeddings.js";
import { PACKAGE_ROOT } from "./package-root.js";
import { buildSearchIndex, rankEntries, type SearchIndex } from "./registry-search.js";

export const LIBRARY_KINDS = ["tool", "skill", "example", "template", "collection", "reference"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/** library/<dir>/<slug> per kind (CONTRACT §2). */
export const LIBRARY_KIND_DIRS: Record<LibraryKind, string> = {
  tool: "tools",
  skill: "skills",
  example: "examples",
  template: "templates",
  collection: "collections",
  reference: "references",
};

export const LIBRARY_ID_PATTERN = /^(tool|skill|example|template|collection|reference)\/[a-z0-9]+(-[a-z0-9]+)*$/;

export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 20;
export const MAX_QUERY_LENGTH = 300;
/**
 * Status factor applied to every candidate's score before ordering — the
 * lexical score and the semantic cosine alike, so both sides of the fusion
 * see the same order. A `preview` entry has not been exercised in-engine by
 * the Summer team, so with comparable evidence the stable entry must win: a
 * preview hit needs a lexical margin of more than 1/PREVIEW_SCORE_FACTOR
 * (25%) over a stable one to outrank it. include_preview:false still removes
 * preview entries entirely; this only orders them. Applied here, not in the
 * index ranker (registry-search.ts), because status is a catalog attribute the
 * routing eval corpus does not carry.
 *
 * Calibration (E2E 2026-09-03 F-18): "make the platformer jump feel better"
 * ranked preview skill/celeste-momentum-platforming (44.6) above stable
 * skill/debugging-game-feel (38.6); at 0.8 the stable entry leads (35.7 vs 38.6)
 * while every preview entry the routing queries expect keeps its top-5 slot.
 */
export const PREVIEW_SCORE_FACTOR = 0.8;

export function statusScoreFactor(status: string | undefined): number {
  return (status ?? "stable") === "preview" ? PREVIEW_SCORE_FACTOR : 1;
}
/** Hard cap on the query-embedding round trip: search must never feel slow. */
export const QUERY_EMBED_TIMEOUT_MS = 1500;
/** How deep each ranking is read before fusion. */
const FUSION_CANDIDATES = 50;

/** One record of registry/generated/index.json (the compiler's buildIndex). */
export interface LibraryIndexEntry {
  id: string;
  kind: string;
  version?: string;
  content_hash?: string;
  summary?: string;
  use_when?: string[];
  facets?: { lifecycle?: string[]; domains?: string[]; modalities?: string[] };
  compatibility?: Record<string, string>;
  related?: Record<string, string[] | undefined>;
  status?: string;
  // tool records
  mcp_tool_name?: string;
  remote?: boolean;
  cli_command?: string;
  authority?: Record<string, boolean>;
  // skill records
  recommended?: boolean;
}

export type MatchedBy = "lexical" | "semantic";

export interface LibrarySearchHit {
  id: string;
  kind: string;
  status: string;
  summary: string;
  use_when: string[];
  /** Lexical: the ranker's score. Fused: the RRF score. Comparable only within one response. */
  score: number;
  matched_by: MatchedBy[];
  /** Tool hits carry the MCP name so a hit can be turned into a call. */
  mcp_tool_name?: string;
}

export interface LibrarySearchOptions {
  kinds?: readonly string[];
  limit?: number;
  includePreview?: boolean;
}

/** Seams for tests and for callers that hold the data already. Every field
 *  optional; the defaults read the shipped package. */
export interface LibrarySearchDeps {
  entries?: LibraryIndexEntry[];
  /** `null` = no embeddings file. `undefined` = read the shipped one. */
  embeddings?: EmbeddingsFile | null;
  /** Query embedder. Return null to signal "unavailable" (never throw). */
  embedQuery?: (query: string) => Promise<number[] | null>;
  env?: NodeJS.ProcessEnv;
}

export interface LibrarySearchResult {
  hits: LibrarySearchHit[];
  /** True when a query vector was obtained and fused into the ranking. */
  semantic: boolean;
}

// ── Input schema (mirrors library/tools/search-library/resource.yaml; parity-tested) ──

export const searchLibraryInputShape = {
  query: z
    .string()
    .min(1)
    .max(MAX_QUERY_LENGTH)
    .describe(
      "The task in plain words — what you are building, fixing, or looking for (e.g. 'make stylized water', 'the player falls through the floor', 'which tool reads script errors')."
    ),
  kinds: z
    .array(z.enum(LIBRARY_KINDS))
    .optional()
    .describe("Restrict to these kinds (tool, skill, example, template, collection, reference). Omit for all kinds."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(`Maximum results, 1-${MAX_SEARCH_LIMIT} (default ${DEFAULT_SEARCH_LIMIT}).`),
  include_preview: z
    .boolean()
    .optional()
    .describe("Include status: preview entries — not yet exercised in-engine by the Summer team (default true). false = stable only."),
};

export const searchLibraryInputSchema = z.object(searchLibraryInputShape).strict();
export type SearchLibraryArgs = z.infer<typeof searchLibraryInputSchema>;

// ── Index loading (cached per process) ─────────────────────────────────────

const INDEX_RELPATH = join("registry", "generated", "index.json");
const EMBEDDINGS_RELPATH = join("registry", "generated", EMBEDDINGS_FILE);

let indexCache: LibraryIndexEntry[] | null = null;
let embeddingsCache: EmbeddingsFile | null | undefined;
const searchIndexCache = new WeakMap<LibraryIndexEntry[], SearchIndex>();

/** Test-only seam: forget the cached index and embeddings file. */
export function _resetLibrarySearchForTests(): void {
  indexCache = null;
  embeddingsCache = undefined;
}

/**
 * The shipped catalog. Throws when the generated file is missing or
 * unparsable — the npm package always ships it, so that is a broken install,
 * not a search miss.
 */
export function loadLibraryIndex(): LibraryIndexEntry[] {
  if (indexCache) return indexCache;
  const file = join(PACKAGE_ROOT, INDEX_RELPATH);
  let parsed: { resources?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8")) as { resources?: unknown };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `registry/generated/index.json is missing or unreadable in this install (${reason}). The summer-engine package always ships it — reinstall or update the package.`
    );
  }
  const resources = Array.isArray(parsed.resources) ? parsed.resources : [];
  indexCache = resources.filter(
    (entry): entry is LibraryIndexEntry =>
      !!entry && typeof entry === "object" && typeof (entry as LibraryIndexEntry).id === "string" && typeof (entry as LibraryIndexEntry).kind === "string"
  );
  return indexCache;
}

function searchIndexFor(entries: LibraryIndexEntry[]): SearchIndex {
  let index = searchIndexCache.get(entries);
  if (!index) {
    index = buildSearchIndex(entries);
    searchIndexCache.set(entries, index);
  }
  return index;
}

/** The shipped embeddings sidecar, or null when absent/unusable. Cached. */
export function loadEmbeddingsFile(): EmbeddingsFile | null {
  if (embeddingsCache !== undefined) return embeddingsCache;
  const file = join(PACKAGE_ROOT, EMBEDDINGS_RELPATH);
  try {
    embeddingsCache = existsSync(file) ? parseEmbeddingsFile(JSON.parse(readFileSync(file, "utf-8"))) : null;
  } catch {
    embeddingsCache = null;
  }
  return embeddingsCache;
}

// ── Query embedding (default provider wiring) ──────────────────────────────

/**
 * Embed the query with the configured provider. Returns null on ANY problem
 * — offline, timeout, non-2xx, bad body, invalid gateway config — so search
 * degrades to lexical instead of failing. `SUMMER_EMBED_URL=off` disables the
 * network call entirely (the query text is otherwise sent to the provider).
 */
export async function embedQueryWithConfiguredProvider(
  query: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<number[] | null> {
  try {
    const override = env.SUMMER_EMBED_URL?.trim();
    if (override === "off") return null;
    const url = override || `${await resolveGatewayUrl()}${EMBED_PATH}`;
    let token: string | null = null;
    try {
      token = await getAuthToken();
    } catch {
      token = null;
    }
    const provider = createEmbedProvider({ url, token, timeoutMs: QUERY_EMBED_TIMEOUT_MS });
    return (await provider(query)).vector;
  } catch {
    return null;
  }
}

// ── Search ─────────────────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function toHit(entry: LibraryIndexEntry, score: number, matchedBy: MatchedBy[]): LibrarySearchHit {
  const hit: LibrarySearchHit = {
    id: entry.id,
    kind: entry.kind,
    status: entry.status ?? "stable",
    summary: entry.summary ?? "",
    use_when: Array.isArray(entry.use_when) ? entry.use_when : [],
    score: round4(score),
    matched_by: matchedBy,
  };
  if (entry.kind === "tool" && typeof entry.mcp_tool_name === "string") hit.mcp_tool_name = entry.mcp_tool_name;
  return hit;
}

/**
 * Rank the library for `query`. Deprecated entries never surface (they exist
 * for alias continuity); preview entries surface unless includePreview is
 * false. Never throws for provider/embeddings reasons.
 */
export async function searchLibraryDetailed(
  query: string,
  options: LibrarySearchOptions = {},
  deps: LibrarySearchDeps = {}
): Promise<LibrarySearchResult> {
  const entries = deps.entries ?? loadLibraryIndex();
  const env = deps.env ?? process.env;
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT)));
  const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
  const includePreview = options.includePreview ?? true;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const eligible = (entry: LibraryIndexEntry | undefined): entry is LibraryIndexEntry => {
    if (!entry) return false;
    if (kinds && !kinds.has(entry.kind)) return false;
    const status = entry.status ?? "stable";
    if (status === "deprecated") return false;
    if (!includePreview && status === "preview") return false;
    return true;
  };

  const factorFor = (id: string): number => statusScoreFactor(byId.get(id)?.status);
  const byScoreThenId = (a: { id: string; score: number }, b: { id: string; score: number }) =>
    b.score - a.score || a.id.localeCompare(b.id);

  const index = searchIndexFor(entries);
  const lexical = rankEntries(index, query, { limit: index.docs.length })
    .filter((hit) => hit.score > 0 && eligible(byId.get(hit.id)))
    .map((hit) => ({ id: hit.id, score: hit.score * factorFor(hit.id) }))
    .sort(byScoreThenId);

  // Semantic side — every failure mode collapses to "not available".
  let semanticRanked: Array<{ id: string; score: number }> = [];
  let semantic = false;
  if (env.SUMMER_EMBED_URL?.trim() !== "off") {
    const embeddings = deps.embeddings !== undefined ? deps.embeddings : loadEmbeddingsFile();
    if (embeddings && Object.keys(embeddings.entries).length > 0) {
      const embed = deps.embedQuery ?? ((q: string) => embedQueryWithConfiguredProvider(q, env));
      let vector: number[] | null = null;
      try {
        vector = await embed(query);
      } catch {
        vector = null;
      }
      if (vector && vector.length === embeddings.dims) {
        semanticRanked = scoreSemantic(embeddings, vector, (id) => eligible(byId.get(id)), factorFor);
        semantic = true;
      }
    }
  }

  if (!semantic) {
    return { hits: lexical.slice(0, limit).map((hit) => toHit(byId.get(hit.id)!, hit.score, ["lexical"])), semantic };
  }

  const lexicalIds = lexical.slice(0, FUSION_CANDIDATES).map((hit) => hit.id);
  const semanticIds = semanticRanked.slice(0, FUSION_CANDIDATES).map((hit) => hit.id);
  const lexicalSet = new Set(lexicalIds);
  const semanticSet = new Set(semanticIds);
  const fused = reciprocalRankFusion([lexicalIds, semanticIds]);
  const hits = fused.slice(0, limit).map((f) => {
    const matchedBy: MatchedBy[] = [];
    if (lexicalSet.has(f.id)) matchedBy.push("lexical");
    if (semanticSet.has(f.id)) matchedBy.push("semantic");
    return toHit(byId.get(f.id)!, f.score, matchedBy);
  });
  return { hits, semantic };
}

/** Cosine over every stored vector for eligible ids, times the status
 *  factor; positive scores only, sorted desc then by id. */
function scoreSemantic(
  embeddings: EmbeddingsFile,
  queryVector: number[],
  eligible: (id: string) => boolean,
  factorFor: (id: string) => number
): Array<{ id: string; score: number }> {
  const scored: Array<{ id: string; score: number }> = [];
  for (const [id, entry] of Object.entries(embeddings.entries)) {
    if (!eligible(id)) continue;
    let vector: Float32Array;
    try {
      vector = decodeVector(entry.vector);
    } catch {
      continue;
    }
    if (vector.length !== queryVector.length) continue;
    const score = cosineSimilarity(queryVector, vector);
    if (score > 0) scored.push({ id, score: score * factorFor(id) });
  }
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** The ranked hits for `query` (see searchLibraryDetailed). */
export async function searchLibrary(
  query: string,
  options: LibrarySearchOptions = {},
  deps: LibrarySearchDeps = {}
): Promise<LibrarySearchHit[]> {
  return (await searchLibraryDetailed(query, options, deps)).hits;
}

// ── Tool payload (both faces) ──────────────────────────────────────────────

export interface SearchLibraryPayload {
  query: string;
  semantic: boolean;
  count: number;
  results: LibrarySearchHit[];
  hint: string;
}

export function searchHint(hits: readonly LibrarySearchHit[]): string {
  if (hits.length === 0) {
    return "No entry matched. Rephrase in task words (what you are building or fixing), or drop the kinds filter; if the library truly has nothing, say so instead of guessing.";
  }
  const top = hits[0]!.id;
  return `Read one with summer_read_library {"id": "${top}"} before acting on it (shell: summer tool read-library --args '{"id":"${top}"}'). Scores compare only within this response.`;
}

/** What summer_search_library and `summer tool search-library` return. */
export async function runSearchLibrary(args: SearchLibraryArgs, deps: LibrarySearchDeps = {}): Promise<SearchLibraryPayload> {
  const { hits, semantic } = await searchLibraryDetailed(
    args.query,
    { kinds: args.kinds, limit: args.limit, includePreview: args.include_preview },
    deps
  );
  return { query: args.query, semantic, count: hits.length, results: hits, hint: searchHint(hits) };
}
