/**
 * Embeddings — the one implementation of the wire protocol, the vector
 * encoding, and the vector math behind semantic library search.
 *
 * Shared by the runtime (src/core/library-search.ts: embed the QUERY) and the
 * registry compiler (scripts/generate-registry/embed.ts: embed every ENTRY
 * into registry/generated/embeddings.json). Deliberately free of relative
 * imports so the compiler script can load it as plain TypeScript the way
 * evals/routing/runner.ts loads registry-search.ts.
 *
 * Provider protocol (SUMMER_EMBED_URL, or <gateway>/api/mcp/embed):
 *   POST { text } -> 2xx JSON { vector: number[], model?: string }
 * Anything else — non-2xx, timeout, malformed body, wrong dims — is a
 * provider failure. Callers decide what that means (the runtime degrades to
 * lexical search; the compiler aborts the embed step).
 *
 * File format (registry/generated/embeddings.json), a sidecar of index.json:
 *   { _generated, model, dims, encoding: "base64-float32",
 *     entries: { "<id>": { content_hash, vector: "<base64 float32 LE>" } } }
 * base64 float32 is ~2x smaller than rounded JSON number arrays and ~5x
 * smaller than full-precision ones (measured on 384-dim vectors), and
 * lossless for float32 providers.
 */

export const EMBEDDINGS_FILE = "embeddings.json";
export const EMBEDDINGS_ENCODING = "base64-float32";
export const EMBED_PATH = "/api/mcp/embed";

export interface EmbeddingsEntry {
  content_hash: string;
  /** base64-encoded little-endian float32 array (EMBEDDINGS_ENCODING). */
  vector: string;
}

export interface EmbeddingsFile {
  _generated?: string;
  model: string;
  dims: number;
  encoding: typeof EMBEDDINGS_ENCODING;
  entries: Record<string, EmbeddingsEntry>;
}

export interface EmbedResponse {
  vector: number[];
  model?: string;
}

export type EmbedProvider = (text: string) => Promise<EmbedResponse>;

export interface EmbedProviderOptions {
  url: string;
  /** Summer account token; sent as an Authorization header when present. */
  token?: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

// ── Vector encoding ────────────────────────────────────────────────────────

export function encodeVector(vector: readonly number[]): string {
  const floats = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) floats[i] = vector[i];
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString("base64");
}

export function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength % 4 !== 0) throw new Error("embedding vector: byte length is not a multiple of 4");
  // Copy into an aligned buffer: Buffer slices from the pool are not 4-aligned.
  const aligned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(aligned).set(bytes);
  return new Float32Array(aligned);
}

// ── Vector math ────────────────────────────────────────────────────────────

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Reciprocal rank fusion (Cormack et al. 2009): score(d) = sum over lists of
 *  1 / (k + rank), rank starting at 1. Ties break on id for determinism. */
export const RRF_K = 60;

export function reciprocalRankFusion(
  rankedLists: ReadonlyArray<readonly string[]>,
  k = RRF_K
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// ── Text to embed ──────────────────────────────────────────────────────────

export interface EmbeddableEntry {
  summary?: unknown;
  use_when?: unknown;
  facets?: unknown;
}

/** The text an entry is embedded from: summary + use_when + facets. Same
 *  function at compile time and (for tests/tools) at runtime so the two can
 *  never drift. */
export function buildEmbeddingText(entry: EmbeddableEntry): string {
  const parts: string[] = [];
  if (typeof entry.summary === "string") parts.push(entry.summary.trim());
  if (Array.isArray(entry.use_when)) {
    for (const line of entry.use_when) if (typeof line === "string") parts.push(line.trim());
  }
  if (entry.facets && typeof entry.facets === "object" && !Array.isArray(entry.facets)) {
    const facetWords: string[] = [];
    for (const value of Object.values(entry.facets as Record<string, unknown>)) {
      if (Array.isArray(value)) for (const v of value) if (typeof v === "string") facetWords.push(v);
    }
    if (facetWords.length > 0) parts.push(facetWords.join(" "));
  }
  return parts.filter((p) => p.length > 0).join("\n");
}

// ── File parsing ───────────────────────────────────────────────────────────

/** Shape-tolerant parse; returns null for anything unusable so callers can
 *  fall back to lexical search instead of throwing. */
export function parseEmbeddingsFile(json: unknown): EmbeddingsFile | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const raw = json as Record<string, unknown>;
  if (raw.encoding !== EMBEDDINGS_ENCODING) return null;
  if (typeof raw.dims !== "number" || !Number.isInteger(raw.dims) || raw.dims <= 0) return null;
  if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) return null;
  const entries: Record<string, EmbeddingsEntry> = {};
  for (const [id, value] of Object.entries(raw.entries as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.content_hash !== "string" || typeof entry.vector !== "string") continue;
    entries[id] = { content_hash: entry.content_hash, vector: entry.vector };
  }
  return {
    _generated: typeof raw._generated === "string" ? raw._generated : undefined,
    model: typeof raw.model === "string" ? raw.model : "unknown",
    dims: raw.dims,
    encoding: EMBEDDINGS_ENCODING,
    entries,
  };
}

// ── Provider client ────────────────────────────────────────────────────────

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Build a provider: POST { text } to `url`, expect { vector, model? }.
 * Throws on every failure mode (network, timeout, non-2xx, malformed body).
 * Never logs: the runtime caller runs inside a stdio MCP server.
 */
export function createEmbedProvider(options: EmbedProviderOptions): EmbedProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (text: string): Promise<EmbedResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      const response = await fetchImpl(options.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`embedding provider responded ${response.status}`);
      const body = (await response.json()) as Record<string, unknown>;
      if (!isFiniteNumberArray(body.vector)) throw new Error("embedding provider returned no numeric vector");
      return {
        vector: body.vector,
        ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
