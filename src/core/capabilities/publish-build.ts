import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { resolveGatewayUrl } from "../config.js";
import { getStoreAccessToken, OAuthError } from "../oauth.js";
import { appendStoreJsonLine } from "../store.js";
import { readJsonResponse } from "../util/http.js";
import { readLastExport } from "./export-game.js";
import { publishDownload } from "./publish-download.js";
import { BuildToolError, declarationMismatch, readSummerBundle, type SummerBundle } from "./summer-bundle.js";

/**
 * summer_publish_build: upload a summer.games export to the creator's game
 * through the same creator store routes Studio's export upload uses
 * (/api/creator-store/*, build-publications):
 *
 *   POST games/{g}/build-publications            declare the export (idempotent)
 *   POST .../{p}:source-upload                    open the part plan (64 MiB parts)
 *   POST .../{p}:signParts                        presigned PUT per part, bound to its SHA-256
 *   PUT  <part URL>                               bytes straight from disk
 *   POST .../{p}:source-complete                  seal it (idempotent)
 *   GET  .../{p}                                  wait until Summer made the Build
 *   POST games/{g}/builds/{b}/client-packages     name the Build's client pack
 *   POST .../{p}:publish                          only with publish=true
 *
 * Mirrors Studio's export upload, including its idempotency keys, so a retry continues
 * the same publication instead of creating another one.
 *
 * Auth: the Summer store OAuth token from "summer login --store" (audience
 * mcp.summerengine.com/mcp), sent as a bearer token.
 */

const STORE_PROXY_PATH = "/api/creator-store";
const PART_BYTES = 64 * 1024 * 1024;
const MAX_SIGNED_PARTS = 100;
const CONCURRENCY = 3;
const PART_RETRIES = 3;
const DEFAULT_WAIT_SECONDS = 600;
const POLL_MS = 3_000;
/** Store client versions: vMAJOR.MINOR.PATCH[-rN]. */
export const CLIENT_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-r[1-9]\d*)?$/;
const INTAKE_DONE = ["preview_ready", "published", "ready", "succeeded"];
const NOT_ACTIONABLE = "deployment_not_actionable";
/** Games without a server run on the Summer Games phone apps only (the store's standalone targets). */
const STANDALONE_TARGETS = ["ios", "android"];

/** Why the Platform did not take the export, in plain words (same text Studio shows). */
const INTAKE_FAILURES: Record<string, string> = {
  game_identity_mismatch: "This export belongs to another game. Upload it to its original game, or make a portable export for this game.",
  bundle_invalid: "Summer could not read this export. Export the game again and upload the new file.",
  declaration_mismatch: "The export's game or settings do not match this upload. Use the original game or export a new version with the intended settings.",
  template_set_unavailable: "Summer Games cannot run this Summer version yet. Update Summer Engine, export again and upload the new file.",
  client_version_conflict: "This version number already belongs to a different export. Use a new clientVersion.",
  artifact_exists: "This exact export is already uploaded for this game. Export a new version and upload that.",
  approval_denied: "Summer Games did not approve this game, so it cannot take new builds.",
  capacity_limit_reached: "Summer Games is busy right now. Try again in a few minutes.",
};

export interface PublishBuildInput {
  gameId?: string;
  /** Exported .zip. Defaults to the last summer_export_game result. */
  file?: string;
  clientVersion?: string;
  /** Also approve the Build for players (needs a game that passed review). */
  publish?: boolean;
  /**
   * A web build or native download (summer_export_game format "download"):
   * the store versions platform (web, macos-universal, windows-x64,
   * linux-x64). Read from the last export when it was a download.
   */
  platform?: string;
  confirm?: boolean;
  /** How long to wait for Summer to make the Build before returning. */
  waitSeconds?: number;
  face: "cli" | "mcp";
}

export interface PublishBuildDependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  token: () => Promise<string>;
}

export const defaultDependencies: PublishBuildDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
  token: () => getStoreAccessToken(),
};

export interface Store {
  call<T = Record<string, unknown>>(
    method: string,
    path: string,
    options?: { body?: unknown; key?: string }
  ): Promise<T>;
}

export function storeError(status: number, code: string, message: string | undefined, requestId?: string): BuildToolError {
  if (status === 401) {
    // The token was sent and refused: signing in again gives the same token
    // shape and the same answer, so it is not the first thing to try.
    return new BuildToolError(
      "store_auth_refused",
      `The Summer store did not accept this sign-in${message ? `: ${message.replace(/\.$/, "")}` : ""}.`,
      'Recovery: run "summer doctor" (Store line) to see the store\'s answer. Signing in again does not change a refusal of a valid sign-in. Until the store accepts agent sign-in for this account, upload the .zip in Studio (Store > your game > Exports).',
      status,
      requestId ? { requestId } : undefined
    );
  }
  if (status === 403 && code === "owner_approval_required") {
    return new BuildToolError(
      "owner_approval_required",
      message || "Only the game's owner can do this.",
      "Recovery: nothing went live. Submit with summer_store_submit and give the owner the approval link it returns; a live game's new download is finished by the owner in Studio.",
      status
    );
  }
  if (status === 403) {
    return new BuildToolError("store_forbidden", message || "This account cannot change that game.", "Recovery: check that the game belongs to the signed-in account.", status);
  }
  if (status === 404 && code === "not_found") {
    return new BuildToolError("store_not_found", "The Summer store has no such game, or this part of the store is not open for this account.", "Recovery: check gameId (Studio shows it in the store page URL).", status);
  }
  if (status === 503 || code === "store_unavailable") {
    return new BuildToolError("store_unavailable", message || "Summer Games is not reachable right now.", "Recovery: try again in a few minutes.", status);
  }
  return new BuildToolError(code, INTAKE_FAILURES[code] ?? message ?? `The Summer store refused the request (${status}).`, "Recovery: read the message, fix the export or version, and retry.", status);
}

export function createStore(baseUrl: string, token: string, deps: PublishBuildDependencies): Store {
  return {
    async call<T>(method: string, path: string, options: { body?: unknown; key?: string } = {}): Promise<T> {
      let response: Response;
      try {
        response = await deps.fetch(`${baseUrl}${STORE_PROXY_PATH}/${path}`, {
          method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
            ...(options.key ? { "idempotency-key": options.key } : {}),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        throw new BuildToolError(
          "store_network_failed",
          `Could not reach the Summer store: ${error instanceof Error ? error.message : String(error)}.`,
          "Recovery: check your network and retry; a retry continues the same upload."
        );
      }
      const { json } = await readJsonResponse(response);
      const body = (json && typeof json === "object" ? json : {}) as Record<string, any>;
      if (!response.ok) {
        const error = body.error && typeof body.error === "object" ? body.error : {};
        const requestId = [error.requestId, body.requestId, response.headers.get("x-request-id")].find((value) => typeof value === "string" && value) as string | undefined;
        throw storeError(response.status, typeof error.code === "string" ? error.code : `http_${response.status}`, typeof error.message === "string" ? error.message : undefined, requestId);
      }
      return body as T;
    },
  };
}

const seg = encodeURIComponent;

function assertPartUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!url.username && !url.password && (url.protocol === "https:" || (local && url.protocol === "http:"))) return url.toString();
  } catch {
    // fall through
  }
  throw new BuildToolError("store_unsafe_upload_url", "The store returned an unsafe upload URL.", "Recovery: nothing was uploaded to it; report the store response as a security issue.");
}

/** Whole-file and per-part SHA-256 ("sha256:<hex>") in one pass. */
export async function hashParts(path: string, partSize: number): Promise<{ sha256: string; sizeBytes: number; parts: string[] }> {
  const whole = createHash("sha256");
  const parts: string[] = [];
  let part = createHash("sha256");
  let inPart = 0;
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024 })) {
    let buffer = chunk as Buffer;
    whole.update(buffer);
    sizeBytes += buffer.length;
    while (buffer.length) {
      const take = Math.min(buffer.length, partSize - inPart);
      part.update(buffer.subarray(0, take));
      inPart += take;
      buffer = buffer.subarray(take);
      if (inPart === partSize) {
        parts.push(`sha256:${part.digest("hex")}`);
        part = createHash("sha256");
        inPart = 0;
      }
    }
  }
  if (inPart > 0 || parts.length === 0) parts.push(`sha256:${part.digest("hex")}`);
  return { sha256: `sha256:${whole.digest("hex")}`, sizeBytes, parts };
}

export interface Grant {
  partNumber: number;
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

export function readGrants(body: Record<string, any>): Grant[] {
  if (!Array.isArray(body.parts)) {
    throw new BuildToolError("store_invalid_response", "The store did not return part upload URLs.", "Recovery: retry; a retry continues the same upload.");
  }
  return body.parts.map((item: Record<string, any>) => {
    const grant = item.upload && typeof item.upload === "object" ? { ...item.upload, partNumber: item.partNumber } : item;
    const headers = Object.fromEntries(Object.entries(grant.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return {
      partNumber: Number(grant.partNumber),
      url: assertPartUrl(grant.url),
      headers,
      expiresAt: Date.parse(grant.expiresAt) || 0,
    };
  });
}

async function readPart(path: string, partNumber: number, partSize: number, sizeBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const start = (partNumber - 1) * partSize;
  const length = Math.min(sizeBytes, start + partSize) - start;
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(new ArrayBuffer(length));
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length) throw new BuildToolError("export_changed", "The export file changed during upload.", "Recovery: export again and retry.");
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Upload the given parts: signed in batches, PUT from disk, re-signed when
 * refused or about to expire. `sign` asks the store for URLs (build
 * publications bind each to its part SHA-256; store versions to its length).
 */
export async function uploadParts(
  sign: (partNumbers: number[]) => Promise<Grant[]>,
  file: string,
  sizeBytes: number,
  plan: { partSizeBytes: number; partCount: number },
  deps: PublishBuildDependencies,
  parts: number[] = Array.from({ length: plan.partCount }, (_, index) => index + 1)
): Promise<void> {
  const queue = [...parts];
  const grants = new Map<number, Grant>();
  let signing: Promise<void> | null = null;
  const fresh = (grant?: Grant) => grant !== undefined && grant.expiresAt - deps.now() > 60_000;
  const grantFor = async (partNumber: number): Promise<Grant> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (fresh(grants.get(partNumber))) return grants.get(partNumber)!;
      if (!signing) {
        const batch = [...new Set([partNumber, ...queue.filter((n) => !fresh(grants.get(n)))])].slice(0, MAX_SIGNED_PARTS);
        signing = sign(batch)
          .then((signed) => {
            for (const grant of signed) grants.set(grant.partNumber, grant);
          })
          .finally(() => {
            signing = null;
          });
      }
      await signing;
    }
    throw new BuildToolError("store_sign_failed", `The store did not sign part ${partNumber}.`, "Recovery: retry; a retry continues the same upload.");
  };

  const worker = async () => {
    for (let partNumber = queue.shift(); partNumber !== undefined; partNumber = queue.shift()) {
      const body = await readPart(file, partNumber, plan.partSizeBytes, sizeBytes);
      for (let attempt = 0; ; attempt++) {
        const grant = await grantFor(partNumber);
        let status: number | null = null;
        try {
          const response = await deps.fetch(grant.url, {
            method: "PUT",
            headers: grant.headers,
            body,
            redirect: "error",
            signal: AbortSignal.timeout(600_000),
          });
          if (response.ok) break;
          status = response.status;
        } catch {
          status = null;
        }
        // An expired or refused signature gets a new URL on the next try.
        if (status === 400 || status === 403) grants.delete(partNumber);
        if (attempt >= PART_RETRIES) {
          throw new BuildToolError(
            "store_part_upload_failed",
            `Part ${partNumber} of ${plan.partCount} did not upload${status ? ` (${status})` : ""}.`,
            "Recovery: retry with the same file and clientVersion; the upload continues where it stopped."
          );
        }
        await deps.sleep(500 * 2 ** attempt);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}

export function normalizeClientVersion(value?: string): string {
  const raw = value?.trim() ?? "";
  const version = /^\d/.test(raw) ? `v${raw}` : raw;
  if (!CLIENT_VERSION.test(version)) {
    throw new BuildToolError(
      "client_version_invalid",
      `clientVersion "${raw}" is not a Summer client version.`,
      'Recovery: pass vMAJOR.MINOR.PATCH, for example "v1.0.0" (a re-upload of the same version adds -r2, -r3, ...).'
    );
  }
  return version;
}

function targetPlatforms(bundle: SummerBundle): string[] {
  const mismatch = declarationMismatch(bundle);
  if (mismatch) {
    throw new BuildToolError(
      "declaration_mismatch",
      `The store would refuse this upload (declaration_mismatch): ${mismatch}. Nothing was uploaded and no version was used.`,
      "Recovery: export again with summer_export_game alignDeclaration:true (it sets summer.build.json targetPlatforms to the targets you export), or with targets equal to what summer.build.json declares; then upload the new export."
    );
  }
  if (bundle.hosted) return bundle.targetPlatforms;
  const other = bundle.targetPlatforms.filter((platform) => !STANDALONE_TARGETS.includes(platform));
  if (other.length) {
    throw new BuildToolError(
      "platforms_unsupported",
      `A game without a server runs on iPhone and Android only for now; this export also targets ${other.join(", ")}.`,
      'Recovery: export again with summer_export_game targets ["ios"] or ["ios","android"]; ship macOS or Windows as a download (format "download").'
    );
  }
  // The Build declares exactly what the bundle declares (declaration_mismatch otherwise).
  return bundle.targetPlatforms;
}

type GameSummary = { id: unknown; name: unknown; slug: unknown; status: unknown; targets: unknown };

/** The signed-in person's store games, or why the store did not list them. */
async function listGames(deps: PublishBuildDependencies): Promise<{ games: GameSummary[] } | { error: string }> {
  try {
    const store = createStore(await resolveGatewayUrl(), await storeToken(deps), deps);
    const page = await store.call<{ items?: Array<Record<string, any>> }>("GET", "games");
    return { games: (page.items ?? []).map((game) => ({ id: game.id, name: game.name, slug: game.slug, status: game.status, targets: game.supportedPlatforms ?? [] })) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** gameId is required: the error carries the person's games, or why the store did not list them. */
async function listGamesOrThrow(deps: PublishBuildDependencies): Promise<never> {
  const listed = await listGames(deps);
  if ("games" in listed) {
    throw new BuildToolError(
      "game_required",
      listed.games.length
        ? "gameId is required: pick one of your store games below (the export is uploaded to one existing game)."
        : "gameId is required, and this account has no store game yet.",
      listed.games.length
        ? "Recovery: call again with gameId from the list."
        : "Recovery: create the store game first (summer_store_create_game), then call again with its gameId.",
      undefined,
      { games: listed.games }
    );
  }
  throw new BuildToolError(
    "game_required",
    `gameId is required, and the store did not list your games: ${listed.error}`,
    "Recovery: copy the game id from Studio (the store page URL) and retry.",
    undefined,
    { listError: listed.error }
  );
}

async function storeToken(deps: PublishBuildDependencies): Promise<string> {
  try {
    return await deps.token();
  } catch (error) {
    if (error instanceof OAuthError) throw new BuildToolError(error.code, error.message.replace(` ${error.recovery}`, ""), error.recovery);
    throw error;
  }
}

/**
 * Before the person confirms, prove the target is real: the game exists for
 * this account, and its store page lists the platforms the export targets.
 */
export async function checkStoreGame(
  gameId: string,
  exportTargets: string[],
  deps: PublishBuildDependencies
): Promise<{ game: { gameId: string; name: string | null; status: string | null; targets: string[] }; warnings: string[] }> {
  const store = createStore(await resolveGatewayUrl(), await storeToken(deps), deps);
  let game: Record<string, any>;
  try {
    game = await store.call<Record<string, any>>("GET", `games/${seg(gameId)}`);
  } catch (error) {
    if (error instanceof BuildToolError && error.status === 404) {
      const listed = await listGames(deps);
      throw new BuildToolError(
        "game_not_found",
        "games" in listed
          ? `There is no store game "${gameId}" for this account, so nothing can be uploaded to it.`
          : `The store did not find game "${gameId}", and did not list your games either: ${listed.error}`,
        "games" in listed && listed.games.length
          ? "Recovery: call again with gameId from the list."
          : "Recovery: create the store game first (summer_store_create_game), or copy its id from Studio (the store page URL).",
        404,
        "games" in listed ? { games: listed.games } : undefined
      );
    }
    throw error;
  }
  const targets: string[] = Array.isArray(game.supportedPlatforms) ? game.supportedPlatforms.filter((value: unknown): value is string => typeof value === "string") : [];
  // The store page speaks catalog names (ios, android, macos, windows, linux, web) or store ids (macos-universal, ...).
  const catalog = new Set(targets.map((target) => target.replace(/-(universal|x64)$/, "")));
  const unlisted = exportTargets.filter((target) => !catalog.has(target));
  const warnings = unlisted.length
    ? [`The store page of "${game.name ?? gameId}" does not list ${unlisted.join(", ")} (it lists ${targets.join(", ") || "no platforms"}). Players on ${unlisted.join(", ")} will not see this build until the store page lists them: add them with summer_store_update_listing.`]
    : [];
  return { game: { gameId, name: typeof game.name === "string" ? game.name : null, status: typeof game.status === "string" ? game.status : null, targets }, warnings };
}

export type PublishBuildResult = Record<string, unknown> & { ok: true; status: string };

export async function publishBuild(
  input: PublishBuildInput,
  overrides: Partial<PublishBuildDependencies> = {}
): Promise<PublishBuildResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const gameId = input.gameId?.trim();
  const fileInput = input.file?.trim();
  const last = await readLastExport();
  const file = fileInput ? resolve(fileInput) : last?.path;
  if (!file) {
    throw new BuildToolError("export_required", "No export to upload.", "Recovery: run summer_export_game first, or pass file with the exported .zip.");
  }
  // The store's second path: a web build or native download becomes a store version.
  const platform = input.platform?.trim() || (last?.path === file ? last.storePlatform : undefined);
  if (platform) {
    const clientVersion = normalizeClientVersion(input.clientVersion);
    if (!gameId) return listGamesOrThrow(deps);
    const download = { gameId, file, platform, clientVersion, confirm: input.confirm, waitSeconds: input.waitSeconds, face: input.face };
    if (input.confirm === true) return publishDownload(download, deps);
    const preview = await publishDownload(download, deps);
    return { ...preview, game: (await checkStoreGame(gameId, [], deps)).game };
  }
  if (extname(file).toLowerCase() !== ".zip") {
    throw new BuildToolError("export_format_unsupported", `${file} is not a summer.games .zip export.`, "Recovery: export with summer_export_game and upload that .zip.");
  }
  const clientVersion = normalizeClientVersion(input.clientVersion);
  const bundle = await readSummerBundle(file);
  const platforms = targetPlatforms(bundle);
  const digest = await hashParts(file, PART_BYTES);
  const publish = input.publish === true;
  const target = {
    gameId: gameId ?? null,
    file,
    sha256: digest.sha256,
    sizeBytes: digest.sizeBytes,
    clientVersion,
    mainScene: bundle.mainScene,
    targetPlatforms: platforms,
    hosted: bundle.hosted,
    summerVersion: bundle.summerVersion,
    publish,
  };

  if (!gameId) return listGamesOrThrow(deps);

  if (input.confirm !== true) {
    const checked = await checkStoreGame(gameId, platforms, deps);
    return {
      ok: true,
      status: "confirmation_required",
      target,
      game: checked.game,
      ...(checked.warnings.length ? { warnings: checked.warnings } : {}),
      next: `Show the user this exact game (name and id), file, digest, size, version and publish choice. Only after they approve, call again with confirm=true. Nothing was uploaded.`,
    };
  }

  const audit = { at: new Date(deps.now()).toISOString(), operation: "publish_build", face: input.face, ...target };
  const token = await storeToken(deps);
  const store = createStore(await resolveGatewayUrl(), token, deps);
  await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "started" });
  // Same keys Studio derives: the same bytes, version and scene are one declaration.
  const key = (write: string) =>
    createHash("sha256").update(`${gameId}:${clientVersion}:${bundle.mainScene}:${digest.sha256}:${write}`).digest("hex");
  const publications = `games/${seg(gameId)}/build-publications`;

  try {
    const accepted = await store.call<Record<string, any>>("POST", publications, {
      key: key("create:0"),
      body: {
        source: { kind: "exported-game", format: "summer-bundle", archiveSha256: digest.sha256, sizeBytes: digest.sizeBytes },
        clientVersion,
        ...(bundle.hostedBuild ? { exportedClient: { entryPoint: bundle.mainScene } } : {}),
        build: bundle.hostedBuild
          ? { ...bundle.hostedBuild, version: clientVersion }
          : { version: clientVersion, executionMode: "standalone", targetPlatforms: platforms, client: { entryPoint: bundle.mainScene } },
      },
    });
    const publicationId = String(accepted.publicationId ?? "");
    if (!publicationId) throw new BuildToolError("store_invalid_response", "The store did not return a publication id.", "Recovery: retry; the same upload continues.");
    const publicationPath = `${publications}/${seg(publicationId)}`;

    let publication = await store.call<Record<string, any>>("GET", publicationPath);
    let uploaded = false;
    if (publication.state === "uploading" && publication.progress?.phase !== "inspecting") {
      const opened = await store.call<Record<string, any>>("POST", `${publicationPath}:source-upload`, { body: {} });
      const plan = { partSizeBytes: Number(opened.upload?.partSizeBytes), partCount: Number(opened.upload?.partCount) };
      if (!(plan.partSizeBytes > 0) || plan.partCount !== Math.max(1, Math.ceil(digest.sizeBytes / plan.partSizeBytes))) {
        throw new BuildToolError("store_invalid_response", "The store's part plan does not fit this file.", "Recovery: retry; if it repeats, report the store as unhealthy.");
      }
      const partHashes = plan.partSizeBytes === PART_BYTES ? digest.parts : (await hashParts(file, plan.partSizeBytes)).parts;
      await uploadParts(
        async (numbers) => readGrants(await store.call("POST", `${publicationPath}:signParts`, { body: { parts: numbers.map((n) => ({ partNumber: n, sha256: partHashes[n - 1] })) } })),
        file,
        digest.sizeBytes,
        plan,
        deps
      );
      await store.call("POST", `${publicationPath}:source-complete`, { body: {}, key: key(`seal:${publicationId}`) });
      uploaded = true;
    }

    const deadline = deps.now() + (input.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
    for (;;) {
      publication = await store.call<Record<string, any>>("GET", publicationPath);
      if (INTAKE_DONE.includes(publication.state)) break;
      if (publication.state === "failed" || publication.state === "cancelled") {
        const code = typeof publication.errorCode === "string" ? publication.errorCode : "publication_failed";
        throw new BuildToolError(
          code,
          (code === "declaration_mismatch" && publication.errorMessage) || INTAKE_FAILURES[code] || publication.errorMessage || "Summer could not make a build from this upload.",
          // The store checks the declaration and the bundle before it records a
          // client pack, so those refusals leave the version free.
          code === "declaration_mismatch" || code === "bundle_invalid"
            ? "Recovery: fix what the message names, export again and retry; the same clientVersion still works, because a refused upload records no version."
            : "Recovery: export again, use a new clientVersion, and retry.",
          undefined,
          { publicationId }
        );
      }
      if (deps.now() >= deadline) {
        const result = {
          ok: true as const,
          status: "processing",
          gameId,
          publicationId,
          buildId: accepted.buildId ?? publication.buildId ?? null,
          state: publication.state,
          uploaded,
          next: "Summer is still checking the export. Call summer_publish_build again with the same file and clientVersion to continue waiting; nothing is uploaded twice.",
        };
        await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "processing", publicationId });
        return result;
      }
      await deps.sleep(POLL_MS);
    }

    const buildId = String(publication.buildId ?? accepted.buildId ?? "");
    let clientPackageId: string | null = publication.clientPackage?.id ?? null;
    if (!clientPackageId) {
      // The Build's client pack answers to the same declaration its upload made.
      const named = await store.call<Record<string, any>>("POST", `games/${seg(gameId)}/builds/${seg(buildId)}/client-packages`, {
        body: {
          clientSha256: bundle.clientPack.sha256,
          clientSize: bundle.clientPack.size,
          mainScene: bundle.mainScene,
          version: clientVersion,
          ...(bundle.hosted && bundle.compositionPath ? { compositionPath: bundle.compositionPath } : {}),
        },
      });
      clientPackageId = named.package?.id ?? null;
    }

    let published = false;
    let publishNote: string | null = null;
    if (publish) {
      try {
        await store.call("POST", `${publicationPath}:publish`, { body: {}, key: key(`publish:${publicationId}`) });
        published = true;
      } catch (error) {
        if (!(error instanceof BuildToolError && error.status === 409 && error.code === NOT_ACTIONABLE)) throw error;
        publishNote = "The game has not passed review yet, so this Build waits as a preview.";
      }
    }

    await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "succeeded", publicationId, buildId, published });
    return {
      ok: true,
      status: published ? "published" : "uploaded",
      gameId,
      publicationId,
      buildId,
      clientPackageId,
      state: publication.state,
      clientVersion,
      sha256: digest.sha256,
      sizeBytes: digest.sizeBytes,
      published,
      ...(publishNote ? { publishNote } : {}),
      next: published
        ? "The Build is approved. Summer checks the client pack per platform; Studio shows the result."
        : "The Build exists as a preview. Summer checks the client pack per platform; publish it from Studio or call again with publish=true.",
    };
  } catch (error) {
    await appendStoreJsonLine("creator-audit.jsonl", {
      ...audit,
      outcome: "failed",
      code: error instanceof BuildToolError ? error.code : "publish_build_failed",
      status: error instanceof BuildToolError ? error.status ?? null : null,
    });
    throw error;
  }
}
