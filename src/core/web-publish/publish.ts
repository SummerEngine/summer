/**
 * One-step publishing of an HTML5 web game to summer.games.
 *
 * Contract: summer-platform management API (audited at origin/main 71f3175ab,
 * 2026-10-06; internal/management/http.go, http_creator_catalog.go,
 * http_creator_store.go, internal/creatorstore/versions.go, objects.go):
 *
 *   GET  /v1/management/games                         list my games (reuse by id/name)
 *   POST /v1/management/games                         create (Idempotency-Key)
 *   POST /v1/management/games/{g}/store/versions      {platform:"web",fileName,sizeBytes,label}
 *   POST .../store/versions/{v}:signParts             {partNumbers:[...<=100]}
 *   PUT  <presigned S3 part URL>                      exact planned Content-Length
 *   POST .../store/versions/{v}:complete              {}
 *   GET  .../store/versions/{v}                       poll processing -> ready|rejected
 *   GET  /v1/management/games/{g}                     creatorRevisionId + creatorState
 *   GET/PATCH .../revisions/{r}                       ETag "game-revision:<r>:<n>"
 *   POST .../revisions/{r}:submit                     If-Match + Idempotency-Key -> 202
 *   POST .../revisions/{r}:publish                    approved revision -> 202
 *
 * Store routes exist only when the server sets SUMMER_PLAY_ORIGIN; a mux 404
 * (non-JSON) on them is reported as games_store_unavailable.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { appendStoreJsonLine, readStoreJson, writeStoreJson } from "../store.js";
import { GamesAuthError, getGamesAccessToken, tokenAudience } from "./oauth.js";
import { WebBuildError, scanWebBuildFolder, validateWebZip, type WebBuildSummary } from "./validate.js";
import { writeZip } from "./zip.js";

export const DEFAULT_GAMES_API_URL = "https://api.summer.games";
export const DEFAULT_GAMES_WEB_URL = "https://summer.games";
const MANAGEMENT = "/v1/management";
const MAX_SIGNED_PARTS = 100;
const PART_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 3000;
const GAMES_FILE = "games-web-publish.json";
const AUDIT_FILE = "games-publish-audit.jsonl";
export const CONTENT_RATINGS = ["everyone", "everyone10Plus", "teen"] as const;
export type ContentRating = (typeof CONTENT_RATINGS)[number];

export class WebPublishError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery: string,
    readonly status?: number,
    readonly details?: Record<string, unknown>
  ) {
    super(`${message} ${recovery}`);
    this.name = "WebPublishError";
  }
}

export interface WebPublishDependencies {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  randomId: () => string;
  log: (message: string) => void;
  getAccessToken: () => Promise<string>;
}

const defaultDeps: WebPublishDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: Date.now,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  randomId: randomUUID,
  log: () => {},
  getAccessToken: async () => (await getGamesAccessToken()).accessToken,
};

function originFromEnv(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const url = new URL(raw);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new WebPublishError("games_api_url_invalid", `${name} must use HTTPS (HTTP only for localhost).`, `Recovery: unset ${name} or set an HTTPS origin.`);
  }
  return url.origin;
}

export function gamesApiOrigin(): string {
  return originFromEnv("SUMMER_GAMES_API_URL", DEFAULT_GAMES_API_URL);
}

export function gamesWebOrigin(): string {
  return originFromEnv("SUMMER_GAMES_WEB_URL", DEFAULT_GAMES_WEB_URL);
}

export function storePageUrl(gameId: string): string {
  return `${gamesWebOrigin()}/games/${encodeURIComponent(gameId)}`;
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

function recoveryFor(status: number, code: string, store: boolean): string {
  if (status === 401) return 'Recovery: run "summer login --games --force" and retry.';
  if (code === "creator_restricted") return "Recovery: your creator account is restricted; contact Summer support.";
  if (status === 404) {
    return store
      ? "Recovery: check the game id belongs to your account (summer.games games you own); if it does, the store upload routes may not be enabled on this server yet."
      : "Recovery: check the game id belongs to your Summer Engine account.";
  }
  if (status === 429) return "Recovery: wait for the Retry-After interval, then retry.";
  if (code === "upload_expired") return "Recovery: rerun the command to start a fresh upload.";
  if (code === "quota_exceeded") return "Recovery: you have reached the game limit for your account; reuse an existing game with --game <gameId>.";
  if (status === 412) return "Recovery: the listing changed elsewhere; rerun the command.";
  if (status >= 500) return "Recovery: retry shortly; the summer.games API reported a temporary failure.";
  return "Recovery: read the server message, fix the input, and retry.";
}

class ApiClient {
  constructor(
    private readonly deps: WebPublishDependencies,
    private readonly token: string,
    private readonly origin: string
  ) {}

  async request(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; store?: boolean; expect?: number[] } = {}
  ): Promise<ApiResult> {
    let response: Response;
    try {
      response = await this.deps.fetch(`${this.origin}${MANAGEMENT}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new WebPublishError(
        "games_network_failed",
        `The summer.games API request ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}.`,
        "Recovery: check your network and retry. Nothing new is claimed as published."
      );
    }
    const text = await response.text().catch(() => "");
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = null;
    }
    if (response.ok && body) return { status: response.status, body, headers: response.headers };
    if (!body) {
      if (response.status === 404 && options.store) {
        throw new WebPublishError(
          "games_store_unavailable",
          "The summer.games store upload routes are not enabled on this server (no JSON route answered).",
          "Recovery: web uploads are not live yet on this environment; retry after the store launch, or point SUMMER_GAMES_API_URL at an environment where they are enabled.",
          404
        );
      }
      throw new WebPublishError(
        "games_invalid_response",
        `The summer.games API returned a non-JSON response (${response.status}) for ${method} ${path}.`,
        recoveryFor(response.status, "", Boolean(options.store)),
        response.status
      );
    }
    const envelope = (body.error ?? {}) as { code?: unknown; message?: unknown; requestId?: unknown; retryable?: unknown };
    const code = typeof envelope.code === "string" ? envelope.code : "games_request_failed";
    const message = typeof envelope.message === "string" ? envelope.message : `request refused (${response.status})`;
    const retryAfter = response.headers.get("retry-after");
    throw new WebPublishError(
      code,
      `summer.games refused ${method} ${path}: ${message}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}.`,
      recoveryFor(response.status, code, Boolean(options.store)),
      response.status,
      { requestId: envelope.requestId ?? null, retryable: envelope.retryable === true }
    );
  }
}

// ---------------------------------------------------------------------------
// Local packaging
// ---------------------------------------------------------------------------

interface PreparedArchive {
  source: string;
  sourceKind: "folder" | "zip";
  zipPath: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  summary: WebBuildSummary;
  cleanup: () => Promise<void>;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Server rule: ^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$ ending in .zip. */
export function zipFileName(source: string): string {
  const base = basename(source).replace(/\.zip$/i, "");
  const clean = base.replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 120).trimEnd();
  return `${clean || "web-build"}.zip`;
}

export async function prepareWebArchive(path: string): Promise<PreparedArchive> {
  const source = resolve(path);
  const info = await lstat(source).catch(() => null);
  if (!info) {
    throw new WebBuildError("web_build_not_found", `${source} does not exist.`, "Recovery: export the web build and pass its folder or .zip.");
  }
  if (info.isSymbolicLink()) {
    throw new WebBuildError("web_build_symlink", `${source} is a symlink.`, "Recovery: pass the real build folder or .zip.");
  }
  if (info.isDirectory()) {
    const summary = await scanWebBuildFolder(source);
    const dir = await mkdtemp(join(tmpdir(), "summer-web-publish-"));
    const zipPath = join(dir, "build.zip");
    const { sizeBytes } = await writeZip(
      zipPath,
      summary.files.map((file) => ({ name: file.name, path: file.path! }))
    );
    if (sizeBytes > 500 * 1024 * 1024) {
      await rm(dir, { recursive: true, force: true });
      throw new WebBuildError("web_build_too_large", "The packaged zip is larger than 500 MiB.", "Recovery: reduce asset sizes, then rebuild.");
    }
    return {
      source,
      sourceKind: "folder",
      zipPath,
      fileName: zipFileName(source),
      sizeBytes,
      sha256: await sha256File(zipPath),
      summary,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }
  if (info.isFile() && source.toLowerCase().endsWith(".zip")) {
    const summary = await validateWebZip(source, info.size);
    return {
      source,
      sourceKind: "zip",
      zipPath: source,
      fileName: zipFileName(source),
      sizeBytes: info.size,
      sha256: await sha256File(source),
      summary,
      cleanup: async () => {},
    };
  }
  throw new WebBuildError("web_build_unsupported_input", `${source} is neither a folder nor a .zip file.`, "Recovery: pass the exported web build folder (containing index.html) or a .zip of it.");
}

// ---------------------------------------------------------------------------
// Game resolution
// ---------------------------------------------------------------------------

interface GamesRecord {
  schemaVersion: 1;
  builds: Record<string, { gameId: string; name: string | null; updatedAt: string }>;
}

async function readGamesRecord(): Promise<GamesRecord> {
  const record = await readStoreJson<GamesRecord>(GAMES_FILE).catch(() => null);
  return record && record.schemaVersion === 1 && record.builds ? record : { schemaVersion: 1, builds: {} };
}

async function rememberGame(source: string, gameId: string, name: string | null, now: number): Promise<void> {
  const record = await readGamesRecord();
  record.builds[source] = { gameId, name, updatedAt: new Date(now).toISOString() };
  await writeStoreJson(GAMES_FILE, record);
}

interface GameRow {
  id: string;
  name?: string;
  slug?: string;
  creatorRevisionId?: string;
  creatorState?: string;
}

async function findGameByName(api: ApiClient, name: string): Promise<GameRow | null> {
  const matches: GameRow[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
    const { body } = await api.request("GET", `/games?${query}`);
    const items = Array.isArray(body.items) ? (body.items as GameRow[]) : [];
    for (const item of items) if (item && item.name === name && typeof item.id === "string") matches.push(item);
    cursor = typeof body.nextCursor === "string" ? body.nextCursor : "";
    if (!cursor) break;
  }
  if (matches.length > 1) {
    throw new WebPublishError(
      "games_name_ambiguous",
      `You own ${matches.length} games named "${name}" (${matches.map((m) => m.id).join(", ")}).`,
      "Recovery: pass --game <gameId> to choose one."
    );
  }
  return matches[0] ?? null;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

interface PartGrant {
  partNumber: number;
  method: string;
  url: string;
  headers: Record<string, string>;
}

function assertPartGrant(value: unknown): PartGrant {
  const grant = value as Partial<PartGrant> | null;
  if (!grant || typeof grant.partNumber !== "number" || grant.method !== "PUT" || typeof grant.url !== "string") {
    throw new WebPublishError("games_invalid_response", "signParts returned a malformed part grant.", "Recovery: do not retry blindly; report the summer.games API response.");
  }
  const url = new URL(grant.url);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.username || url.password || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))) {
    throw new WebPublishError("games_unsafe_upload_url", "signParts returned an unsafe upload URL.", "Recovery: do not upload; report the summer.games API response as a security issue.");
  }
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(grant.headers ?? {})) {
    if (typeof val === "string" && !["host", "content-length"].includes(key.toLowerCase())) headers[key] = val;
  }
  return { partNumber: grant.partNumber, method: "PUT", url: grant.url, headers };
}

async function uploadParts(
  api: ApiClient,
  deps: WebPublishDependencies,
  base: string,
  versionId: string,
  archive: PreparedArchive,
  partSize: number,
  partCount: number
): Promise<void> {
  const handle = await open(archive.zipPath, "r");
  try {
    for (let first = 1; first <= partCount; first += MAX_SIGNED_PARTS) {
      const numbers = Array.from({ length: Math.min(MAX_SIGNED_PARTS, partCount - first + 1) }, (_, i) => first + i);
      let grants = await signParts(api, base, versionId, numbers);
      for (const number of numbers) {
        const offset = (number - 1) * partSize;
        const length = Math.min(partSize, archive.sizeBytes - offset);
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, offset);
        let attempt = 0;
        for (;;) {
          attempt += 1;
          const grant = grants.get(number);
          if (!grant) throw new WebPublishError("games_invalid_response", `signParts did not return part ${number}.`, "Recovery: rerun the command.");
          let status = 0;
          let failure = "";
          try {
            const response = await deps.fetch(grant.url, {
              method: "PUT",
              headers: grant.headers,
              body: chunk,
              signal: AbortSignal.timeout(300_000),
            });
            status = response.status;
            if (response.ok) break;
            failure = `status ${status}`;
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
          }
          if (attempt >= PART_ATTEMPTS || (status >= 400 && status < 500 && status !== 403 && status !== 408 && status !== 429)) {
            throw new WebPublishError(
              "games_upload_failed",
              `Uploading part ${number}/${partCount} failed (${failure}).`,
              "Recovery: rerun the command; a fresh upload starts and the incomplete one expires on its own.",
              status || undefined
            );
          }
          deps.log(`Part ${number}/${partCount} failed (${failure}); retrying.`);
          if (status === 403) grants = await signParts(api, base, versionId, numbers);
          await deps.sleep(1000 * attempt);
        }
        deps.log(`Uploaded part ${number}/${partCount}.`);
      }
    }
  } finally {
    await handle.close();
  }
}

async function signParts(api: ApiClient, base: string, versionId: string, numbers: number[]): Promise<Map<number, PartGrant>> {
  const { body } = await api.request("POST", `${base}/${encodeURIComponent(versionId)}:signParts`, {
    body: { partNumbers: numbers },
    store: true,
  });
  const parts = Array.isArray(body.parts) ? body.parts.map(assertPartGrant) : [];
  return new Map(parts.map((part) => [part.partNumber, part]));
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export type ReviewOutcome =
  | "submitted_for_review"
  | "in_review"
  | "publishing"
  | "live"
  | "needs_content_rating"
  | "action_required"
  | "skipped";

interface Revision {
  revisionId: string;
  state: string;
  etagRevision: number;
  contentRating?: string;
  contentDescriptors?: string[] | null;
}

function revisionETag(result: ApiResult, revision: Revision): string {
  return result.headers.get("etag") ?? `"game-revision:${revision.revisionId}:${revision.etagRevision}"`;
}

async function handleReview(
  api: ApiClient,
  deps: WebPublishDependencies,
  gameId: string,
  contentRating: ContentRating | undefined
): Promise<{ outcome: ReviewOutcome; revisionState: string | null; operationId: string | null; detail: string }> {
  const g = `/games/${encodeURIComponent(gameId)}`;
  const { body: game } = await api.request("GET", g);
  const revisionId = typeof game.creatorRevisionId === "string" ? game.creatorRevisionId : "";
  const state = typeof game.creatorState === "string" ? game.creatorState : "";
  if (!revisionId) {
    return { outcome: "action_required", revisionState: null, operationId: null, detail: "The game has no store listing revision to submit." };
  }
  const r = `${g}/revisions/${encodeURIComponent(revisionId)}`;
  switch (state) {
    case "PUBLISHED":
      return { outcome: "live", revisionState: state, operationId: null, detail: "The game is published; summer.games serves the newest ready web build." };
    case "SUBMITTED":
    case "VERIFYING":
      return { outcome: "in_review", revisionState: state, operationId: null, detail: "The listing is already in review; this build is served once it is published." };
    case "SCHEDULED":
      return { outcome: "publishing", revisionState: state, operationId: null, detail: "The listing is approved and scheduled to publish." };
    case "APPROVED": {
      const { body } = await api.request("POST", `${r}:publish`, {
        body: {},
        headers: { "idempotency-key": deps.randomId() },
      });
      return {
        outcome: "publishing",
        revisionState: state,
        operationId: typeof body.operationId === "string" ? body.operationId : null,
        detail: "The listing was approved; publication was requested.",
      };
    }
    case "DRAFT": {
      let current = await api.request("GET", r);
      let revision = current.body as unknown as Revision;
      if (!revision.contentRating || revision.contentDescriptors == null) {
        if (!contentRating) {
          return {
            outcome: "needs_content_rating",
            revisionState: state,
            operationId: null,
            detail: `The listing needs a content rating before review. Rerun with --content-rating <${CONTENT_RATINGS.join("|")}>.`,
          };
        }
        current = await api.request("PATCH", r, {
          body: { contentRating: revision.contentRating || contentRating, contentDescriptors: revision.contentDescriptors ?? [] },
          headers: { "if-match": revisionETag(current, revision), "idempotency-key": deps.randomId() },
        });
        revision = current.body as unknown as Revision;
      }
      const { body } = await api.request("POST", `${r}:submit`, {
        headers: { "if-match": revisionETag(current, revision), "idempotency-key": deps.randomId() },
      });
      return {
        outcome: "submitted_for_review",
        revisionState: "SUBMITTED",
        operationId: typeof body.operationId === "string" ? body.operationId : null,
        detail: "Submitted for review. Summer reviews new games before they appear in the store.",
      };
    }
    default:
      return {
        outcome: "action_required",
        revisionState: state,
        operationId: null,
        detail: `The listing is ${state || "in an unknown state"}; open the summer.games creator dashboard to address review feedback.`,
      };
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface PublishWebGameInput {
  /** Web build folder (containing index.html) or a .zip of it. */
  path: string;
  /** Existing summer.games game id (game_...). */
  gameId?: string;
  /** Store name; required when a new game is created. */
  name?: string;
  description?: string;
  contentRating?: string;
  /** Version label shown to the creator (max 64 bytes). */
  label?: string;
  /** Submit the listing for review when the build is ready. Default true. */
  submit?: boolean;
  /** Seconds to wait for server-side processing. Default 600. */
  waitSeconds?: number;
  confirm?: boolean;
  face: "cli" | "mcp";
}

export interface PublishWebGameResult {
  ok: true;
  gameId: string;
  gameCreated: boolean;
  versionId: string;
  versionStatus: string;
  rejectionReason: string | null;
  playUrl: string | null;
  storeUrl: string;
  review: { outcome: ReviewOutcome; revisionState: string | null; operationId: string | null; detail: string };
  archive: { source: string; fileName: string; sizeBytes: number; sha256: string; fileCount: number };
}

function validateTextInputs(input: PublishWebGameInput): { name?: string; description?: string; label: string; rating?: ContentRating } {
  const name = input.name?.trim();
  if (name !== undefined && (name.length < 1 || [...name].length > 120)) {
    throw new WebPublishError("games_name_invalid", "The game name must be 1-120 characters.", "Recovery: pass a shorter --name.");
  }
  const description = input.description?.trim();
  if (description !== undefined && (description.length < 1 || [...description].length > 5000)) {
    throw new WebPublishError("games_description_invalid", "The description must be 1-5000 characters.", "Recovery: shorten --description.");
  }
  const label = (input.label ?? "").trim();
  if (Buffer.byteLength(label) > 64 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new WebPublishError("games_label_invalid", "The version label must be at most 64 bytes without control characters.", "Recovery: pass a shorter --label.");
  }
  let rating: ContentRating | undefined;
  if (input.contentRating !== undefined) {
    if (!(CONTENT_RATINGS as readonly string[]).includes(input.contentRating)) {
      throw new WebPublishError("games_content_rating_invalid", `Content rating must be one of ${CONTENT_RATINGS.join(", ")}.`, "Recovery: pass a valid --content-rating.");
    }
    rating = input.contentRating as ContentRating;
  }
  if (input.gameId !== undefined && !/^game_[A-Za-z0-9]+$/.test(input.gameId)) {
    throw new WebPublishError("games_id_invalid", `"${input.gameId}" is not a summer.games game id (game_...).`, "Recovery: copy the id from the game's summer.games URL.");
  }
  return { name, description, label, rating };
}

export async function publishWebGame(
  input: PublishWebGameInput,
  overrides: Partial<WebPublishDependencies> = {}
): Promise<PublishWebGameResult> {
  const deps = { ...defaultDeps, ...overrides };
  const text = validateTextInputs(input);
  const archive = await prepareWebArchive(input.path);
  try {
    const recorded = (await readGamesRecord()).builds[archive.source];
    const plannedGame = input.gameId ?? recorded?.gameId ?? null;
    if (!plannedGame && !text.name) {
      throw new WebPublishError(
        "games_name_required",
        "This build is not linked to a summer.games game yet, so a store name is needed.",
        "Recovery: pass --name \"<Game Name>\" (and --content-rating) to create or reuse the game, or --game <gameId> to update an existing one."
      );
    }
    const auditBase = {
      at: new Date(deps.now()).toISOString(),
      face: input.face,
      source: archive.source,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      fileCount: archive.summary.fileCount,
      gameId: plannedGame,
      name: text.name ?? null,
    };
    if (!input.confirm) {
      await appendStoreJsonLine(AUDIT_FILE, { ...auditBase, outcome: "confirmation_required" });
      const target = plannedGame
        ? `existing game ${plannedGame}${input.gameId ? "" : " (linked to this build folder)"}`
        : `your game named "${text.name}" if one exists, otherwise a new game "${text.name}"`;
      throw new WebPublishError(
        "publish_confirmation_required",
        `Ready to publish ${archive.source} (${archive.summary.fileCount} files, ${archive.sizeBytes} bytes zipped, sha256 ${archive.sha256}) to summer.games as ${target}${input.submit === false ? "" : ", then submit it for review"}.`,
        "Recovery: show this exact target to the user. Only after approval, rerun with --confirm (MCP: confirm=true). Nothing was uploaded.",
        undefined,
        {
          plan: {
            source: archive.source,
            fileCount: archive.summary.fileCount,
            sizeBytes: archive.sizeBytes,
            sha256: archive.sha256,
            gameId: plannedGame,
            name: text.name ?? null,
            submit: input.submit !== false,
          },
        }
      );
    }

    const token = await deps.getAccessToken();
    const audience = tokenAudience(token);
    if (audience.length !== 1 || audience[0] !== "authenticated") {
      throw new WebPublishError(
        "games_token_audience_mismatch",
        `The Summer Engine sign-in token has audience ${JSON.stringify(audience)}, but the summer.games management API accepts only "authenticated".`,
        "Recovery: this is a server configuration mismatch (the Supabase access-token hook rewrites OAuth app tokens to the hosted-MCP audience). Report it; signing in again will not fix it."
      );
    }
    const api = new ApiClient(deps, token, gamesApiOrigin());
    await appendStoreJsonLine(AUDIT_FILE, { ...auditBase, outcome: "started" });

    // 1. Resolve or create the game.
    let gameId = plannedGame;
    let gameCreated = false;
    if (!gameId && text.name) {
      const existing = await findGameByName(api, text.name);
      if (existing) {
        gameId = existing.id;
        deps.log(`Reusing your game "${text.name}" (${gameId}).`);
      }
    }
    if (!gameId) {
      const { body } = await api.request("POST", "/games", {
        body: {
          name: text.name!,
          description: text.description ?? `${text.name} is a game you can play in your browser.`,
          tags: [],
          supportedPlatforms: ["web"],
          ...(text.rating ? { contentRating: text.rating, contentDescriptors: [] } : {}),
        },
        headers: { "idempotency-key": deps.randomId() },
      });
      if (typeof body.gameId !== "string") {
        throw new WebPublishError("games_invalid_response", "Creating the game returned no gameId.", "Recovery: check your games on summer.games before retrying.");
      }
      gameId = body.gameId;
      gameCreated = true;
      deps.log(`Created game "${text.name}" (${gameId}).`);
    }
    await rememberGame(archive.source, gameId, text.name ?? recorded?.name ?? null, deps.now());

    // 2. Create the web store version and upload it.
    const base = `/games/${encodeURIComponent(gameId)}/store/versions`;
    const { body: created } = await api.request("POST", base, {
      body: { platform: "web", fileName: archive.fileName, sizeBytes: archive.sizeBytes, label: text.label },
      store: true,
    });
    const version = (created.version ?? {}) as { id?: unknown };
    const plan = (created.upload ?? {}) as { partSizeBytes?: unknown; partCount?: unknown };
    if (
      typeof version.id !== "string" ||
      typeof plan.partSizeBytes !== "number" ||
      typeof plan.partCount !== "number" ||
      plan.partSizeBytes <= 0 ||
      plan.partCount !== Math.ceil(archive.sizeBytes / plan.partSizeBytes)
    ) {
      throw new WebPublishError("games_invalid_response", "The store version response has no usable upload plan.", "Recovery: upgrade the Summer CLI; if it repeats, report the summer.games API.");
    }
    const versionId = version.id;
    deps.log(`Uploading ${archive.sizeBytes} bytes in ${plan.partCount} part(s) to version ${versionId}.`);
    await uploadParts(api, deps, base, versionId, archive, plan.partSizeBytes, plan.partCount);
    const { body: completed } = await api.request("POST", `${base}/${encodeURIComponent(versionId)}:complete`, {
      body: {},
      store: true,
    });

    // 3. Wait for server-side validation and processing.
    let current = (completed.version ?? {}) as { status?: string; playUrl?: string; rejectionReason?: string };
    const deadline = deps.now() + Math.max(0, input.waitSeconds ?? 600) * 1000;
    while (current.status === "processing" || current.status === "awaiting_upload") {
      if (deps.now() >= deadline) break;
      await deps.sleep(POLL_INTERVAL_MS);
      const { body } = await api.request("GET", `${base}/${encodeURIComponent(versionId)}`, { store: true });
      current = body as typeof current;
    }
    const versionStatus = typeof current.status === "string" ? current.status : "unknown";

    // 4. Submit for review (or publish an approved listing) once the build is ready.
    let review: PublishWebGameResult["review"];
    if (versionStatus === "rejected") {
      review = { outcome: "skipped", revisionState: null, operationId: null, detail: "The build was rejected; nothing was submitted." };
    } else if (versionStatus !== "ready") {
      review = { outcome: "skipped", revisionState: null, operationId: null, detail: "The build is still processing; rerun with the same arguments later to submit it." };
    } else if (input.submit === false) {
      review = { outcome: "skipped", revisionState: null, operationId: null, detail: "Submission skipped (--no-submit)." };
    } else {
      review = await handleReview(api, deps, gameId, text.rating);
    }

    const result: PublishWebGameResult = {
      ok: true,
      gameId,
      gameCreated,
      versionId,
      versionStatus,
      rejectionReason: typeof current.rejectionReason === "string" ? current.rejectionReason : null,
      playUrl: typeof current.playUrl === "string" ? current.playUrl : null,
      storeUrl: storePageUrl(gameId),
      review,
      archive: {
        source: archive.source,
        fileName: archive.fileName,
        sizeBytes: archive.sizeBytes,
        sha256: archive.sha256,
        fileCount: archive.summary.fileCount,
      },
    };
    await appendStoreJsonLine(AUDIT_FILE, {
      ...auditBase,
      gameId,
      outcome: "succeeded",
      versionId,
      versionStatus,
      review: review.outcome,
    });
    return result;
  } catch (error) {
    if (!(error instanceof WebPublishError && error.code === "publish_confirmation_required")) {
      await appendStoreJsonLine(AUDIT_FILE, {
        at: new Date(deps.now()).toISOString(),
        face: input.face,
        source: archive.source,
        outcome: "failed",
        code: error instanceof WebPublishError || error instanceof GamesAuthError || error instanceof WebBuildError ? error.code : "games_publish_failed",
      }).catch(() => {});
    }
    throw error;
  } finally {
    await archive.cleanup();
  }
}
