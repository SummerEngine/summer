/**
 * --embed step — the OPTIONAL embeddings sidecar of the registry compiler.
 *
 * Writes registry/generated/embeddings.json: one vector per library resource,
 * embedded from `summary + use_when + facets` (buildEmbeddingText — the same
 * function the runtime uses) through the same provider protocol runtime
 * search uses (src/core/embeddings.ts createEmbedProvider):
 *
 *   POST { text } -> { vector, model? }   at SUMMER_EMBED_URL or <gateway>/api/mcp/embed
 *
 * Cache by content_hash: only resources whose content_hash changed since the
 * committed sidecar are re-embedded; unchanged vectors are kept byte-for-byte;
 * vectors for ids no longer in the index are pruned. A provider that reports
 * a different model than the sidecar invalidates every cached vector.
 *
 * NOT part of `--check` parity: vectors are nondeterministic across providers
 * and the file is optional (CI never embeds). `checkEmbeddings` only reports
 * — as warnings, exit 0 — entries whose content_hash no longer matches the
 * index, entries without a vector, and vectors for ids that left the index.
 * Missing file: nothing to say.
 *
 * Token: the account token from the existing auth store (SUMMER_TOKEN, else
 * ~/.summer/auth-token — the files src/core/auth.ts owns; mirrored here
 * because this script runs as plain TypeScript and cannot import src/ modules
 * that use ".js" specifiers). Gateway: SUMMER_GATEWAY_URL, else
 * ~/.summer/config.json gateway.url, else production (src/core/config.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EMBEDDINGS_ENCODING,
  EMBEDDINGS_FILE,
  EMBED_PATH,
  buildEmbeddingText,
  createEmbedProvider,
  decodeVector,
  encodeVector,
  parseEmbeddingsFile,
  type EmbedProvider,
  type EmbeddingsEntry,
  type EmbeddingsFile,
} from "../../src/core/embeddings.ts";
import type { LoadedResource } from "./index.ts";
import { stableJson } from "./shared.ts";

export const EMBEDDINGS_BANNER = "GENERATED — do not edit; run npm run generate:registry -- --embed";
export const EMBEDDINGS_RELPATH = `registry/generated/${EMBEDDINGS_FILE}`;
/** Per-request budget at compile time (the runtime query budget is 1.5s). */
export const EMBED_TIMEOUT_MS = 15_000;
export const DEFAULT_EMBED_CONCURRENCY = 4;
const DEFAULT_GATEWAY_URL = "https://www.summerengine.com";

export interface EmbedSummary {
  file: string;
  total: number;
  computed: number;
  reused: number;
  pruned: number;
  model: string;
  dims: number;
  bytes: number;
}

export interface EmbedOptions {
  concurrency?: number;
  log?: (line: string) => void;
}

export function embeddingsPath(rootDir: string): string {
  return path.join(rootDir, "registry", "generated", EMBEDDINGS_FILE);
}

/** `exists:false` = no sidecar (fine). `exists:true, file:null` = present but unusable. */
export function readEmbeddingsFile(rootDir: string): { exists: boolean; file: EmbeddingsFile | null } {
  const abs = embeddingsPath(rootDir);
  if (!fs.existsSync(abs)) return { exists: false, file: null };
  try {
    return { exists: true, file: parseEmbeddingsFile(JSON.parse(fs.readFileSync(abs, "utf8"))) };
  } catch {
    return { exists: true, file: null };
  }
}

async function runPool<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(workers);
}

function sortById(resources: readonly LoadedResource[]): LoadedResource[] {
  return [...resources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Embed every resource whose content_hash is not already covered by the
 * committed sidecar and write registry/generated/embeddings.json.
 */
export async function embedRegistry(
  rootDir: string,
  resources: readonly LoadedResource[],
  provider: EmbedProvider,
  options: EmbedOptions = {},
): Promise<EmbedSummary> {
  const log = options.log ?? (() => {});
  const concurrency = options.concurrency ?? DEFAULT_EMBED_CONCURRENCY;
  const existing = readEmbeddingsFile(rootDir).file;
  const sorted = sortById(resources);
  const ids = new Set(sorted.map((r) => r.id));

  let reusable = new Map<string, EmbeddingsEntry>();
  let pending: LoadedResource[] = [];
  for (const res of sorted) {
    const prev = existing?.entries[res.id];
    if (prev && prev.content_hash === res.contentHash) reusable.set(res.id, prev);
    else pending.push(res);
  }
  const pruned = existing ? Object.keys(existing.entries).filter((id) => !ids.has(id)).length : 0;

  let model = existing?.model ?? "unknown";
  const computed = new Map<string, number[]>();
  if (pending.length > 0) {
    // The first request goes alone: its reported model decides whether the
    // cached vectors are still comparable with what we are about to compute.
    const first = pending[0]!;
    const firstResponse = await provider(buildEmbeddingText(first.data));
    if (firstResponse.model) {
      if (existing && existing.model !== "unknown" && existing.model !== firstResponse.model && reusable.size > 0) {
        log(`generate-registry --embed: provider model changed (${existing.model} -> ${firstResponse.model}); recomputing every vector.`);
        reusable = new Map();
        pending = sorted;
      }
      model = firstResponse.model;
    }
    computed.set(first.id, firstResponse.vector);
    const rest = pending.filter((res) => res.id !== first.id);
    await runPool(rest, concurrency, async (res) => {
      computed.set(res.id, (await provider(buildEmbeddingText(res.data))).vector);
    });
  }

  let dims = existing && reusable.size > 0 ? existing.dims : 0;
  const checkDims = (id: string, length: number) => {
    if (dims === 0) dims = length;
    else if (length !== dims) {
      throw new Error(
        `generate-registry --embed: vector for ${id} has ${length} dims but the sidecar has ${dims}. The provider changed shape — delete ${EMBEDDINGS_RELPATH} and run --embed again.`,
      );
    }
  };
  const entries: Record<string, EmbeddingsEntry> = {};
  for (const res of sorted) {
    const vector = computed.get(res.id);
    if (vector) {
      checkDims(res.id, vector.length);
      entries[res.id] = { content_hash: res.contentHash, vector: encodeVector(vector) };
    } else {
      const prev = reusable.get(res.id)!;
      checkDims(res.id, decodeVector(prev.vector).length);
      entries[res.id] = prev;
    }
  }

  const file: EmbeddingsFile = { _generated: EMBEDDINGS_BANNER, model, dims, encoding: EMBEDDINGS_ENCODING, entries };
  const json = stableJson(file);
  const abs = embeddingsPath(rootDir);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, json, "utf8");
  return {
    file: EMBEDDINGS_RELPATH,
    total: sorted.length,
    computed: computed.size,
    reused: reusable.size,
    pruned,
    model,
    dims,
    bytes: Buffer.byteLength(json, "utf8"),
  };
}

/**
 * Warnings (never drift) about the sidecar vs the regenerated index. Empty
 * when the file is absent or every entry's content_hash matches.
 */
export function checkEmbeddings(rootDir: string, resources: readonly LoadedResource[]): string[] {
  const { exists, file } = readEmbeddingsFile(rootDir);
  if (!exists) return [];
  if (!file) {
    return [`${EMBEDDINGS_RELPATH}: present but not a valid embeddings file — regenerate with \`npm run generate:registry -- --embed\` or delete it`];
  }
  const ids = new Set(resources.map((r) => r.id));
  const stale: string[] = [];
  const missing: string[] = [];
  const orphan: string[] = [];
  for (const res of resources) {
    const entry = file.entries[res.id];
    if (!entry) missing.push(res.id);
    else if (entry.content_hash !== res.contentHash) stale.push(res.id);
  }
  for (const id of Object.keys(file.entries)) if (!ids.has(id)) orphan.push(id);
  const out: string[] = [];
  if (stale.length > 0) out.push(`${EMBEDDINGS_RELPATH}: ${stale.length} stale vector(s) — content changed since embedding: ${stale.join(", ")}`);
  if (missing.length > 0) out.push(`${EMBEDDINGS_RELPATH}: ${missing.length} index entr${missing.length === 1 ? "y" : "ies"} without a vector: ${missing.join(", ")}`);
  if (orphan.length > 0) out.push(`${EMBEDDINGS_RELPATH}: ${orphan.length} vector(s) for ids no longer in the index: ${orphan.join(", ")}`);
  if (out.length > 0) {
    out.push(
      `${EMBEDDINGS_RELPATH}: refresh with \`npm run generate:registry -- --embed\` (needs a Summer login). Stale vectors are still used at runtime; this is a warning, not drift.`,
    );
  }
  return out;
}

// ── Provider from the environment (script side) ────────────────────────────

export interface EmbedEndpoint {
  url: string;
  token: string | null;
  /** Where the URL came from, for the log line. */
  source: "SUMMER_EMBED_URL" | "gateway";
}

function readTrimmed(file: string): string | null {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Mirrors src/core/config.ts resolveGatewayUrl precedence (env > config.json > prod). */
function resolveGateway(env: NodeJS.ProcessEnv, homeDir: string): string {
  const fromEnv = env.SUMMER_GATEWAY_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  try {
    const config = JSON.parse(fs.readFileSync(path.join(homeDir, ".summer", "config.json"), "utf8")) as {
      gateway?: { url?: string };
    };
    const configured = config.gateway?.url?.trim();
    if (configured) return configured.replace(/\/+$/, "");
  } catch {
    // no config file: production
  }
  return DEFAULT_GATEWAY_URL;
}

/**
 * Where to embed and with what token. Fails when there is neither a Summer
 * login nor an explicit SUMMER_EMBED_URL — the gateway endpoint needs an
 * account; a custom endpoint may not.
 */
export function resolveEmbedEndpoint(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): EmbedEndpoint {
  const token = env.SUMMER_TOKEN?.trim() || readTrimmed(path.join(homeDir, ".summer", "auth-token"));
  const override = env.SUMMER_EMBED_URL?.trim();
  if (override && override !== "off") return { url: override, token, source: "SUMMER_EMBED_URL" };
  if (!token) {
    throw new Error(
      "generate-registry --embed needs a Summer login (run `summer login`, or set SUMMER_TOKEN) so the gateway embedding endpoint accepts the requests — or point SUMMER_EMBED_URL at an embedding endpoint that needs no account.",
    );
  }
  return { url: `${resolveGateway(env, homeDir)}${EMBED_PATH}`, token, source: "gateway" };
}

export function createProviderFromEnvironment(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): { provider: EmbedProvider; endpoint: EmbedEndpoint } {
  const endpoint = resolveEmbedEndpoint(env, homeDir);
  return { provider: createEmbedProvider({ url: endpoint.url, token: endpoint.token, timeoutMs: EMBED_TIMEOUT_MS }), endpoint };
}
