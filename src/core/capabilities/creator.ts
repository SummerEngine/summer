import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  getCredentialMetadata,
  getCreatorToken,
} from "../auth.js";
import {
  getCreatorApiUrl,
  readSummerConfig,
} from "../config.js";
import { appendStoreJsonLine } from "../store.js";
import { readJsonResponse } from "../util/http.js";

export type CreatorOperation = "publish" | "releases";
export type CreatorFace = "cli" | "mcp";

export const CREATOR_API_CONTRACT = "summer.creator.v1" as const;
const CREATOR_PUBLISH_PATH = "/api/creator/v1/publish";
const CREATOR_RELEASES_PATH = "/api/creator/v1/releases";
const REQUIRED_SCOPE = "publish";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;


export class CreatorOperationError extends Error {
  constructor(
    readonly code: string,
    readonly operation: CreatorOperation,
    message: string,
    readonly recovery: string,
    readonly status?: number
  ) {
    super(`${message} ${recovery}`);
    this.name = "CreatorOperationError";
  }
}

export interface CreatorClientDependencies {
  fetch: typeof fetch;
  now: () => Date;
}

const defaultDependencies: CreatorClientDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => new Date(),
};

async function resolveProjectId(explicit?: string): Promise<string> {
  const projectId =
    explicit?.trim() || (await readSummerConfig()).creator?.projectId;
  if (!projectId) {
    throw new Error(
      'No creator project is selected. Recovery: pass --project-id <uuid>, or run "summer config set creator.projectId <uuid>".'
    );
  }
  if (!UUID.test(projectId)) {
    throw new Error(
      `Creator project ID "${projectId}" is not a UUID. Recovery: copy the Summer game ID from the creator dashboard and configure it again.`
    );
  }
  return projectId;
}

async function requireCreatorCredential(
  operation: "publish" | "releases"
): Promise<string> {
  const token = await getCreatorToken();
  if (!token) {
    throw new CreatorOperationError(
      "creator_token_required",
      operation,
      "Creator publishing needs a separate Summer Platform creator API token.",
      'Recovery: run "summer login --creator", mint a token with the exact "publish" scope in the opened browser page, and paste its one-time sc_ value. Your core Summer login will not be changed.'
    );
  }
  const metadata = await getCredentialMetadata();
  if (!metadata.creator?.scopes.includes(REQUIRED_SCOPE)) {
    throw new CreatorOperationError(
      "creator_scope_missing",
      operation,
      `The locally recorded creator credential does not declare the exact "${REQUIRED_SCOPE}" scope.`,
      'Recovery: run "summer login --creator --force", mint a new publish-scoped token, and retry. The server will still independently verify the scope.'
    );
  }
  return token;
}

function recoveryForStatus(operation: CreatorOperation, status: number): string {
  if (status === 401 || status === 403) {
    return 'Recovery: run "summer login --creator --force", mint a non-revoked token with the exact "publish" scope, and retry.';
  }
  if (status === 404) {
    return 'Recovery: check creator.projectId against the Summer creator dashboard and make sure that game belongs to the token owner.';
  }
  if (status === 409 && operation === "publish") {
    return "Recovery: read the server detail, bump an immutable version when required, then repeat the unconfirmed command to review the new exact target.";
  }
  return `Recovery: retry once; if it repeats, check creator.apiUrl and the Summer Platform creator API health.`;
}

async function readCreatorResponse(
  response: Response,
  operation: CreatorOperation
): Promise<Record<string, unknown>> {
  const { json, parsed } = await readJsonResponse(response);
  const payload = json as Record<string, unknown>;
  if (!parsed) {
    throw new CreatorOperationError(
      "creator_invalid_response",
      operation,
      `The creator API returned a non-JSON response (${response.status}).`,
      recoveryForStatus(operation, response.status),
      response.status
    );
  }
  if (!response.ok) {
    const code =
      typeof payload.error === "string" ? payload.error : "creator_request_failed";
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : `The creator API refused the request (${response.status}).`;
    const recovery =
      typeof payload.recovery === "string"
        ? payload.recovery
        : recoveryForStatus(operation, response.status);
    throw new CreatorOperationError(
      code,
      operation,
      detail,
      recovery,
      response.status
    );
  }
  if (payload.contract !== CREATOR_API_CONTRACT) {
    throw new CreatorOperationError(
      "creator_contract_mismatch",
      operation,
      `The creator API did not return contract ${CREATOR_API_CONTRACT}.`,
      "Recovery: upgrade the Summer CLI and retry; if it repeats, the configured creator API is incompatible.",
      response.status
    );
  }
  return payload;
}

async function creatorRequest(
  operation: CreatorOperation,
  path: string,
  token: string,
  deps: CreatorClientDependencies,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await deps.fetch(`${await getCreatorApiUrl()}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(operation === "publish" ? 300_000 : 30_000),
    });
  } catch (error) {
    throw new CreatorOperationError(
      "creator_network_failed",
      operation,
      `The creator API request failed: ${
        error instanceof Error ? error.message : String(error)
      }.`,
      "Recovery: check your network and creator.apiUrl, then retry. No successful release is being claimed."
    );
  }
  return readCreatorResponse(response, operation);
}

async function inspectArtifact(path: string): Promise<{
  path: string;
  sizeBytes: number;
  sha256: string;
}> {
  const artifactPath = resolve(path);
  const info = await lstat(artifactPath).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw new Error(
      `Release artifact ${artifactPath} must be a real regular file, not a missing path, directory, or symlink.`
    );
  }
  if (!artifactPath.toLowerCase().endsWith(".pck")) {
    throw new Error(
      `Release artifact ${artifactPath} is not a .pck. Recovery: export a Summer PCK and pass its exact path with --artifact.`
    );
  }
  if (info.size <= 0) {
    throw new Error(
      `Release artifact ${artifactPath} is empty. Recovery: export the Summer PCK again and verify it locally before publishing.`
    );
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
  return {
    path: artifactPath,
    sizeBytes: info.size,
    sha256: hash.digest("hex"),
  };
}

async function readManifest(path?: string): Promise<unknown | undefined> {
  if (!path) return undefined;
  const manifestPath = resolve(path);
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot read release manifest ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }. Recovery: pass a valid JSON manifest or omit --manifest.`
    );
  }
}

function assertUploadUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new CreatorOperationError(
      "creator_invalid_response",
      "publish",
      "The prepare response did not contain an uploadUrl.",
      "Recovery: retry once; if it repeats, report the Summer Platform creator API as unhealthy."
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CreatorOperationError(
      "creator_unsafe_upload_url",
      "publish",
      "The creator API returned a malformed upload URL.",
      "Recovery: do not upload the artifact; report the creator API response as a security issue."
    );
  }
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
  ) {
    throw new CreatorOperationError(
      "creator_unsafe_upload_url",
      "publish",
      "The creator API returned an unsafe upload URL.",
      "Recovery: do not upload the artifact; report the creator API response as a security issue."
    );
  }
  return url.toString();
}

function assertUploadHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CreatorOperationError(
      "creator_invalid_response",
      "publish",
      "The prepare response did not contain signed upload headers.",
      "Recovery: retry once; if it repeats, report the Summer Platform creator API as unhealthy."
    );
  }
  const headers = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
  if (
    headers["content-type"] !== "application/octet-stream" ||
    headers["if-none-match"] !== "*"
  ) {
    throw new CreatorOperationError(
      "creator_unsafe_upload_headers",
      "publish",
      "The prepare response did not bind the expected content type and write-once header.",
      "Recovery: do not upload the artifact; report the creator API response as a security issue."
    );
  }
  return headers;
}

async function uploadArtifact(
  uploadUrl: string,
  headers: Record<string, string>,
  artifactPath: string,
  deps: CreatorClientDependencies
): Promise<void> {
  let response: Response;
  try {
    response = await deps.fetch(uploadUrl, {
      method: "PUT",
      headers,
      body: createReadStream(artifactPath) as unknown as BodyInit,
      // Node fetch requires this for a streaming request body. It is a Node
      // extension and therefore absent from the DOM RequestInit declaration.
      duplex: "half",
      signal: AbortSignal.timeout(600_000),
    } as RequestInit & { duplex: "half" });
  } catch (error) {
    throw new CreatorOperationError(
      "creator_upload_failed",
      "publish",
      `The artifact upload failed: ${
        error instanceof Error ? error.message : String(error)
      }.`,
      "Recovery: rerun the unconfirmed publish command to recompute and review the exact artifact, then retry."
    );
  }
  if (!response.ok) {
    throw new CreatorOperationError(
      "creator_upload_refused",
      "publish",
      `The immutable artifact upload was refused (${response.status}).`,
      response.status === 412
        ? "Recovery: the content-addressed key is already occupied. Do not overwrite it; verify the project/version and retry with a new immutable version."
        : "Recovery: repeat prepare and reproduce every returned signed header exactly, then retry.",
      response.status
    );
  }
}

export interface PublishCreatorInput {
  project?: string;
  artifact?: string;
  manifest?: string;
  version?: string;
  projectId?: string;
  channel?: string;
  notes?: string;
  confirm?: boolean;
  face: CreatorFace;
}

export interface CreatorPublishResult {
  ok: true;
  contract: typeof CREATOR_API_CONTRACT;
  operation: "publish";
  projectId: string;
  releaseId: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  status: string;
  detail: string | null;
}

export async function publishCreator(
  input: PublishCreatorInput,
  overrides: Partial<CreatorClientDependencies> = {}
): Promise<CreatorPublishResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const project = resolve(input.project ?? process.cwd());
  const projectId = await resolveProjectId(input.projectId);
  const channel =
    input.channel?.trim() ||
    (await readSummerConfig()).creator?.channel ||
    "production";
  if (channel !== "production") {
    throw new CreatorOperationError(
      "creator_channel_unsupported",
      "publish",
      `The Summer Platform creator API has no "${channel}" release channel.`,
      'Recovery: use --channel production or run "summer config set creator.channel production". No release was created.'
    );
  }
  const version = input.version?.trim();
  if (!version || !VERSION.test(version)) {
    throw new Error(
      "A release version is required and must be 1–32 characters of letters, numbers, dots, underscores, or hyphens. Recovery: pass --version <value>."
    );
  }
  if (!input.artifact) {
    throw new Error(
      "A release artifact is required. Recovery: export a Summer .pck and pass --artifact <path>; the CLI never guesses an export layout."
    );
  }
  const artifact = await inspectArtifact(input.artifact);
  const manifest = await readManifest(input.manifest);
  const auditBase = {
    at: deps.now().toISOString(),
    operation: "publish",
    face: input.face,
    project,
    projectId,
    channel,
    artifact: artifact.path,
    version,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    notes: input.notes?.trim() || null,
  };

  if (!input.confirm) {
    await appendStoreJsonLine("creator-audit.jsonl", {
      ...auditBase,
      outcome: "confirmation_required",
    });
    throw new CreatorOperationError(
      "publish_confirmation_required",
      "publish",
      `Publishing changes project ${projectId}: version ${version}, sha256 ${artifact.sha256}, ${artifact.sizeBytes} bytes from ${artifact.path}.`,
      "Recovery: show this exact project, version, digest, size, and artifact path to the user. Only after approval, rerun with --confirm (or confirm=true). No release was created."
    );
  }

  let token: string;
  try {
    token = await requireCreatorCredential("publish");
    await appendStoreJsonLine("creator-audit.jsonl", {
      ...auditBase,
      outcome: "started",
      tokenAudience: "summercraft-creator",
      advisoryTokenScopes: [REQUIRED_SCOPE],
    });

    const confirmation = {
      gameId: projectId,
      version,
      sha256: artifact.sha256,
    };
    const prepareBody = {
      contract: CREATOR_API_CONTRACT,
      operation: "prepare",
      ...confirmation,
      sizeBytes: artifact.sizeBytes,
      contentType: "application/octet-stream",
      ...(input.notes?.trim() ? { changelog: input.notes.trim() } : {}),
      ...(manifest !== undefined ? { manifest } : {}),
      confirmation,
    };
    const prepared = await creatorRequest(
      "publish",
      CREATOR_PUBLISH_PATH,
      token,
      deps,
      {
        method: "POST",
        body: JSON.stringify(prepareBody),
      }
    );
    if (prepared.operation !== "prepare") {
      throw new CreatorOperationError(
        "creator_invalid_response",
        "publish",
        "The prepare response named the wrong operation.",
        "Recovery: do not upload the artifact; upgrade the Summer CLI or report the creator API as incompatible."
      );
    }
    if (
      prepared.method !== "PUT" ||
      prepared.finalizeUrl !== CREATOR_PUBLISH_PATH
    ) {
      throw new CreatorOperationError(
        "creator_invalid_response",
        "publish",
        "The prepare response did not bind the expected PUT and versioned finalize route.",
        "Recovery: do not upload the artifact; upgrade the Summer CLI or report the creator API as incompatible."
      );
    }
    await uploadArtifact(
      assertUploadUrl(prepared.uploadUrl),
      assertUploadHeaders(prepared.headers),
      artifact.path,
      deps
    );

    const finalized = await creatorRequest(
      "publish",
      CREATOR_PUBLISH_PATH,
      token,
      deps,
      {
        method: "POST",
        body: JSON.stringify({
          ...prepareBody,
          operation: "finalize",
        }),
      }
    );
    if (
      finalized.operation !== "finalize" ||
      typeof finalized.releaseId !== "string" ||
      !UUID.test(finalized.releaseId) ||
      finalized.status !== "pending_review" ||
      finalized.gameId !== projectId ||
      finalized.version !== version ||
      finalized.sha256 !== artifact.sha256 ||
      finalized.sizeBytes !== artifact.sizeBytes
    ) {
      throw new CreatorOperationError(
        "creator_invalid_response",
        "publish",
        "The finalize response did not echo the exact project, version, digest, size, release ID, and status.",
        "Recovery: query summer releases before retrying; the server may have recorded the release even though its response was incomplete."
      );
    }
    const result: CreatorPublishResult = {
      ok: true,
      contract: CREATOR_API_CONTRACT,
      operation: "publish",
      projectId,
      releaseId: finalized.releaseId,
      version,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      status: finalized.status,
      detail:
        typeof finalized.detail === "string" ? finalized.detail : null,
    };
    await appendStoreJsonLine("creator-audit.jsonl", {
      ...auditBase,
      outcome: "succeeded",
      releaseId: result.releaseId,
      releaseStatus: result.status,
    });
    return result;
  } catch (error) {
    await appendStoreJsonLine("creator-audit.jsonl", {
      ...auditBase,
      outcome: "failed",
      code:
        error instanceof CreatorOperationError
          ? error.code
          : "creator_request_invalid",
      status:
        error instanceof CreatorOperationError ? error.status ?? null : null,
    });
    throw error;
  }
}

export interface ListCreatorReleasesInput {
  projectId?: string;
  limit?: number;
  cursor?: string;
  face: CreatorFace;
}

export interface CreatorRelease {
  releaseId: string;
  gameId: string;
  version: string;
  state: "published" | "pending_review" | "retired";
  gameStatus: string;
  sha256: string | null;
  sizeBytes: number | null;
  changelog: string | null;
  submittedAt: string;
  artifactPlane: "r2" | "legacy";
}

export interface CreatorReleasesResult {
  ok: true;
  contract: typeof CREATOR_API_CONTRACT;
  operation: "releases";
  projectId: string;
  releases: CreatorRelease[];
  nextCursor: string | null;
}

function readReleases(value: unknown, projectId: string): CreatorRelease[] {
  if (!Array.isArray(value)) {
    throw new CreatorOperationError(
      "creator_invalid_response",
      "releases",
      "The creator API response did not contain a releases array.",
      "Recovery: upgrade the Summer CLI and retry; if it repeats, report the creator API as incompatible."
    );
  }
  const releases: CreatorRelease[] = [];
  for (const item of value) {
    const row = item as Partial<CreatorRelease> | null;
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.releaseId !== "string" ||
      !UUID.test(row.releaseId) ||
      row.gameId !== projectId ||
      typeof row.version !== "string" ||
      !["published", "pending_review", "retired"].includes(
        String(row.state)
      ) ||
      typeof row.gameStatus !== "string" ||
      (row.sha256 !== null &&
        (typeof row.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(row.sha256))) ||
      (row.sizeBytes !== null &&
        (typeof row.sizeBytes !== "number" ||
          !Number.isSafeInteger(row.sizeBytes) ||
          row.sizeBytes < 0)) ||
      (row.changelog !== null && typeof row.changelog !== "string") ||
      typeof row.submittedAt !== "string" ||
      !Number.isFinite(Date.parse(row.submittedAt)) ||
      (row.artifactPlane !== "r2" && row.artifactPlane !== "legacy")
    ) {
      throw new CreatorOperationError(
        "creator_invalid_response",
        "releases",
        "The creator API returned a malformed or cross-project release item.",
        "Recovery: do not trust this release list; upgrade the Summer CLI or report the creator API as incompatible."
      );
    }
    releases.push(row as CreatorRelease);
  }
  return releases;
}

export async function listCreatorReleases(
  input: ListCreatorReleasesInput,
  overrides: Partial<CreatorClientDependencies> = {}
): Promise<CreatorReleasesResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const projectId = await resolveProjectId(input.projectId);
  const token = await requireCreatorCredential("releases");
  const params = new URLSearchParams({
    gameId: projectId,
    limit: String(input.limit ?? 20),
  });
  if (input.cursor) params.set("cursor", input.cursor);
  const payload = await creatorRequest(
    "releases",
    `${CREATOR_RELEASES_PATH}?${params}`,
    token,
    deps
  );
  if (payload.gameId !== projectId) {
    throw new CreatorOperationError(
      "creator_invalid_response",
      "releases",
      "The creator API returned release history for a different project.",
      "Recovery: do not trust this release list; check creator.apiUrl and report the response as a security issue."
    );
  }
  if (
    payload.nextCursor !== null &&
    typeof payload.nextCursor !== "string"
  ) {
    throw new CreatorOperationError(
      "creator_invalid_response",
      "releases",
      "The creator API returned a malformed release cursor.",
      "Recovery: omit the cursor and retry from the newest release; report the response if it repeats."
    );
  }
  return {
    ok: true,
    contract: CREATOR_API_CONTRACT,
    operation: "releases",
    projectId,
    releases: readReleases(payload.releases, projectId),
    nextCursor: payload.nextCursor,
  };
}
