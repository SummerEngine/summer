import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  type BigIntStats,
} from "node:fs";
import { lstat, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import { walkProject } from "./cloud/hash.js";
import { getManagementToken } from "./platform-auth.js";
import { getManagementUrl } from "./config.js";

const BUILD_CONFIG_FILE = "summer.build.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const FIXED_ZIP_TIME = new Date("1980-01-01T00:00:00.000Z");
const ACTIVE_STATES = new Set([
  "uploading",
  "pending",
  "materializing",
  "building",
  "publishing",
  "verifying",
]);

export interface BuildProjectConfig {
  schema: "summer.build.v1" | "summer.build.v2";
  gameId: string;
  engineVersion?: string;
  sdkVersion?: string;
  project: { directory: string };
  server: { exportPreset: string };
  runtime: Record<string, unknown>;
}

export interface SourceArchive {
  path: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  cleanup: () => Promise<void>;
}

interface BuildPublicationAccepted {
  operationId: string;
  publicationId: string;
  buildId: string;
  sourceId: string;
  state: "uploading" | "pending";
}

interface BuildPublication {
  id: string;
  operationId: string;
  gameId: string;
  buildId?: string;
  version: string;
  state: string;
  progress?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

interface PublishedBuild {
  id: string;
  gameId: string;
  version: string;
  artifactSha256: string;
  serverImage: string;
  status: string;
}

interface UploadGrant {
  sourceId: string;
  upload: {
    method: string;
    url: string;
    headers: Record<string, string>;
    expiresAt: string;
  };
}

export interface PublishBuildOptions {
  project?: string;
  version: string;
  wait?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface PublishBuildResult {
  gameId: string;
  version: string;
  publicationId: string;
  operationId: string;
  buildId: string;
  state: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  build?: PublishedBuild;
}

export interface PublishBuildDependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
  managementUrl: () => Promise<string | null>;
  managementToken: () => Promise<string>;
}

const defaultDependencies: PublishBuildDependencies = {
  fetch,
  sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  now: Date.now,
  log: console.log,
  managementUrl: getManagementUrl,
  managementToken: getManagementToken,
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(`${name} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  }
}

function token(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`${name} must be a non-empty, trimmed value of at most 128 characters.`);
  }
  return value;
}

function projectDirectory(value: unknown): string {
  const directory = token(value, "project.directory");
  if (
    directory !== "." &&
    (isAbsolute(directory) ||
      directory.includes("\\") ||
      directory === ".." ||
      directory.startsWith("../") ||
      directory.split("/").includes("..") ||
      posix.normalize(directory) !== directory)
  ) {
    throw new Error("project.directory must be '.' or a safe slash-separated relative path.");
  }
  return directory;
}

export async function loadBuildProjectConfig(
  archiveRoot: string
): Promise<BuildProjectConfig> {
  const configPath = join(archiveRoot, BUILD_CONFIG_FILE);
  let info;
  try {
    info = await lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `${BUILD_CONFIG_FILE} was not found in ${archiveRoot}. Add the game's stable server/runtime declaration and retry.`
      );
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) {
    throw new Error(`${configPath} must be a regular JSON file no larger than ${MAX_CONFIG_BYTES} bytes.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error(`${configPath} is not valid JSON.`);
  }
  const root = record(parsed, BUILD_CONFIG_FILE);
  exactKeys(
    root,
    [
      "schema",
      "gameId",
      "engineVersion",
      "sdkVersion",
      "project",
      "server",
      "runtime",
    ],
    BUILD_CONFIG_FILE
  );
  if (root.schema !== "summer.build.v1" && root.schema !== "summer.build.v2") {
    throw new Error('summer.build.json schema must be "summer.build.v1" or "summer.build.v2".');
  }
  const project = record(root.project, "project");
  exactKeys(project, ["directory"], "project");
  const server = record(root.server, "server");
  exactKeys(server, ["exportPreset"], "server");
  const runtime = record(root.runtime, "runtime");
  token(runtime.protocolVersion, "runtime.protocolVersion");
  if (!Array.isArray(runtime.scenes) || runtime.scenes.length === 0) {
    throw new Error("runtime.scenes must contain at least one scene.");
  }
  for (const [index, scene] of runtime.scenes.entries()) {
    token(scene, `runtime.scenes[${index}]`);
  }
  if (runtime.queues !== undefined && !Array.isArray(runtime.queues)) {
    throw new Error("runtime.queues must be an array when present.");
  }

  const gameId = token(root.gameId, "gameId");
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(gameId)) {
    throw new Error("gameId may contain only letters, numbers, underscores, and hyphens.");
  }
  const exportPreset = token(server.exportPreset, "server.exportPreset");
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(exportPreset)) {
    throw new Error("server.exportPreset is not a valid Summer export preset name.");
  }

  const config: BuildProjectConfig = {
    schema: root.schema,
    gameId,
    project: { directory: projectDirectory(project.directory) },
    server: { exportPreset },
    runtime,
  };
  if (root.engineVersion !== undefined) {
    config.engineVersion = token(root.engineVersion, "engineVersion");
  }
  if (root.sdkVersion !== undefined) {
    config.sdkVersion = token(root.sdkVersion, "sdkVersion");
  }
  return config;
}

function expectedProjectFile(
  archiveRoot: string,
  directory: string,
  fileName: string
): string {
  return directory === "."
    ? join(archiveRoot, fileName)
    : join(archiveRoot, ...directory.split("/"), fileName);
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} was not found at ${path}.`);
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a directory or symlink.`);
  }
}

function compareCapturedStat(
  key: string,
  before: { size: number; mtimeNs: string; inode: string },
  after: BigIntStats
): void {
  if (
    after.size !== BigInt(before.size) ||
    after.ino.toString() !== before.inode ||
    after.mtimeNs.toString() !== before.mtimeNs
  ) {
    throw new Error(`${key} changed while it was being packaged. Save the project and retry.`);
  }
}

export async function createSourceArchive(
  project: string | undefined,
  config?: BuildProjectConfig
): Promise<SourceArchive> {
  const archiveRoot = resolve(project ?? process.cwd());
  const rootInfo = await lstat(archiveRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Project root ${archiveRoot} must be a real directory.`);
  }
  const declaration = config ?? (await loadBuildProjectConfig(archiveRoot));
  await requireRegularFile(
    expectedProjectFile(archiveRoot, declaration.project.directory, "project.godot"),
    "project.godot"
  );
  await requireRegularFile(
    expectedProjectFile(
      archiveRoot,
      declaration.project.directory,
      "export_presets.cfg"
    ),
    "export_presets.cfg"
  );

  const walked = await walkProject(archiveRoot, { noCache: true });
  if (walked.skippedSymlinks.length) {
    throw new Error(
      `The source archive cannot contain symlinks. Replace or exclude: ${walked.skippedSymlinks.join(", ")}.`
    );
  }
  if (walked.unstablePaths.length) {
    throw new Error(
      `Files kept changing while they were read. Save the project and retry: ${walked.unstablePaths.join(", ")}.`
    );
  }
  const keys = Object.keys(walked.files).sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right))
  );
  if (!keys.length) throw new Error("The project has no publishable files.");
  const projectPrefix =
    declaration.project.directory === "."
      ? ""
      : `${declaration.project.directory}/`;
  for (const required of ["project.godot", "export_presets.cfg"]) {
    const key = `${projectPrefix}${required}`;
    if (!walked.files[key]) {
      throw new Error(
        `${key} is excluded from the source archive. Remove that ignore rule and retry.`
      );
    }
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "summer-build-publish-"));
  const archivePath = join(temporaryRoot, "source.zip");
  try {
    const zip = new ZipFile();
    for (const key of keys) {
      zip.addFile(walked.diskPathByKey.get(key)!, key, {
        compress: true,
        mtime: FIXED_ZIP_TIME,
        mode: 0o100644,
      });
    }
    const completed = pipeline(
      zip.outputStream,
      createWriteStream(archivePath, { flags: "wx", mode: 0o600 })
    );
    zip.end({ forceZip64Format: false, comment: "" });
    await completed;

    for (const key of keys) {
      const captured = walked.statByKey.get(key)!;
      const diskPath = walked.diskPathByKey.get(key)!;
      compareCapturedStat(key, captured, await stat(diskPath, { bigint: true }));
    }

    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of createReadStream(archivePath)) {
      const bytes = chunk as Buffer;
      sizeBytes += bytes.length;
      if (sizeBytes > MAX_ARCHIVE_BYTES) {
        throw new Error("The source ZIP exceeds the platform 2 GiB limit.");
      }
      hash.update(bytes);
    }
    if (sizeBytes === 0) throw new Error("The source ZIP is empty.");
    return {
      path: archivePath,
      sha256: `sha256:${hash.digest("hex")}`,
      sizeBytes,
      fileCount: keys.length,
      cleanup: async () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function managementOrigin(value: string | null): string {
  if (!value) {
    throw new Error(
      'No management API is configured. Run "summer config set platform.managementUrl https://<the-declared-management-origin>" and retry.'
    );
  }
  return value;
}

function requestKey(prefix: string, ...values: string[]): string {
  return `${prefix}-${createHash("sha256").update(values.join("\0")).digest("hex")}`;
}

async function responseError(response: Response, action: string): Promise<Error> {
  const requestId = response.headers.get("x-request-id");
  let detail = "";
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string } | string;
      code?: string;
      message?: string;
    };
    if (typeof body.error === "string") detail = body.error;
    else detail = body.error?.message ?? body.message ?? body.error?.code ?? body.code ?? "";
  } catch {
    // Error bodies are optional and never trusted as control data.
  }
  return new Error(
    `${action} failed (${response.status})${detail ? `: ${detail}` : ""}${requestId ? ` [request ${requestId}]` : ""}`
  );
}

async function managementRequest<T>(
  deps: PublishBuildDependencies,
  origin: string,
  path: string,
  init: RequestInit = {}
): Promise<{ response: Response; body: T }> {
  // Resolve the session for every management exchange. Hosted builds can run
  // long enough for an otherwise-valid access token to expire while an upload
  // or worker poll is in progress; the auth layer refreshes it when needed.
  const tokenValue = await deps.managementToken();
  const response = await deps.fetch(`${origin}${path}`, {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokenValue}`,
      ...init.headers,
    },
  });
  if (!response.ok) throw await responseError(response, `${init.method ?? "GET"} ${path}`);
  return { response, body: (await response.json()) as T };
}

function validateUploadGrant(
  grant: UploadGrant,
  archive: SourceArchive,
  now: number
): void {
  if (grant.upload.method !== "PUT") {
    throw new Error(`The platform returned unsupported upload method ${grant.upload.method}.`);
  }
  let target: URL;
  try {
    target = new URL(grant.upload.url);
  } catch {
    throw new Error("The platform returned an invalid upload URL.");
  }
  const local =
    target.hostname === "localhost" ||
    target.hostname === "127.0.0.1" ||
    target.hostname === "::1";
  if (target.protocol !== "https:" && !(local && target.protocol === "http:")) {
    throw new Error("The platform upload URL must use HTTPS (except literal loopback development). ");
  }
  if (target.username || target.password || target.hash) {
    throw new Error("The platform returned an unsafe upload URL.");
  }
  const expiresAt = Date.parse(grant.upload.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now + 5_000 ||
    expiresAt > now + 16 * 60_000
  ) {
    throw new Error("The platform returned an invalid or expired upload grant.");
  }
  const seenHeaders = new Set<string>();
  for (const [name, value] of Object.entries(grant.upload.headers)) {
    const lower = name.toLowerCase();
    if (
      seenHeaders.has(lower) ||
      lower === "authorization" ||
      lower === "cookie" ||
      lower === "proxy-authorization" ||
      /[\r\n]/.test(name) ||
      /[\r\n]/.test(value)
    ) {
      throw new Error(`The platform returned forbidden upload header ${name}.`);
    }
    seenHeaders.add(lower);
  }
  const header = (name: string) =>
    Object.entries(grant.upload.headers).find(
      ([candidate]) => candidate.toLowerCase() === name
    )?.[1];
  const length = header("content-length");
  if (length !== String(archive.sizeBytes)) {
    throw new Error("The platform upload grant does not match the exact archive size.");
  }
  if (header("content-type")?.toLowerCase() !== "application/zip") {
    throw new Error("The platform upload grant does not bind application/zip.");
  }
  if (header("if-none-match") !== "*") {
    throw new Error("The platform upload grant is not write-once.");
  }
}

async function uploadArchive(
  deps: PublishBuildDependencies,
  grant: UploadGrant,
  archive: SourceArchive
): Promise<void> {
  validateUploadGrant(grant, archive, deps.now());
  const init = {
    method: "PUT",
    redirect: "error" as const,
    headers: grant.upload.headers,
    body: createReadStream(archive.path) as unknown as BodyInit,
    duplex: "half" as const,
    signal: AbortSignal.timeout(10 * 60_000),
  };
  const response = await deps.fetch(grant.upload.url, init as RequestInit);
  if (!response.ok && response.status !== 412) {
    throw await responseError(response, "Source upload");
  }
}

function publicationPath(gameId: string, publicationId?: string): string {
  const base = `/v1/management/games/${encodeURIComponent(gameId)}/build-publications`;
  return publicationId ? `${base}/${encodeURIComponent(publicationId)}` : base;
}

function buildIntent(config: BuildProjectConfig, version: string): Record<string, unknown> {
  return {
    schema: config.schema,
    version: token(version, "version"),
    ...(config.engineVersion ? { engineVersion: config.engineVersion } : {}),
    ...(config.sdkVersion ? { sdkVersion: config.sdkVersion } : {}),
    project: config.project,
    server: config.server,
    runtime: config.runtime,
  };
}

export async function publishBuild(
  options: PublishBuildOptions,
  overrides: Partial<PublishBuildDependencies> = {}
): Promise<PublishBuildResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const archiveRoot = resolve(options.project ?? process.cwd());
  const config = await loadBuildProjectConfig(archiveRoot);
  const version = token(options.version, "version");
  const origin = managementOrigin(await deps.managementUrl());
  const archive = await createSourceArchive(archiveRoot, config);
  try {
    deps.log(
      `Packaged ${archive.fileCount} files (${archive.sizeBytes} bytes, ${archive.sha256}).`
    );
    const body = JSON.stringify({
      source: {
        kind: "platform-upload",
        archiveSha256: archive.sha256,
        sizeBytes: archive.sizeBytes,
      },
      build: buildIntent(config, version),
    });
    const createKey = requestKey("buildpub", config.gameId, body);
    const accepted = (
      await managementRequest<BuildPublicationAccepted>(
        deps,
        origin,
        publicationPath(config.gameId),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": createKey,
          },
          body,
        }
      )
    ).body;
    deps.log(`Draft ${accepted.publicationId} created for Build ${accepted.buildId}.`);

    let publication = (
      await managementRequest<BuildPublication>(
        deps,
        origin,
        publicationPath(config.gameId, accepted.publicationId)
      )
    ).body;
    if (publication.state === "uploading") {
      const grant = (
        await managementRequest<UploadGrant>(
          deps,
          origin,
          `${publicationPath(config.gameId, accepted.publicationId)}:source-upload`,
          { method: "POST" }
        )
      ).body;
      if (grant.sourceId !== accepted.sourceId) {
        throw new Error("The upload grant source identity does not match the draft.");
      }
      await uploadArchive(deps, grant, archive);
      deps.log("Source uploaded; sealing the draft.");
      const completePath = `${publicationPath(config.gameId, accepted.publicationId)}:source-complete`;
      const complete = await deps.fetch(`${origin}${completePath}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${await deps.managementToken()}`,
          "Idempotency-Key": requestKey(
            "buildsrc",
            config.gameId,
            accepted.publicationId,
            archive.sha256
          ),
        },
      });
      if (!complete.ok) throw await responseError(complete, "Source completion");
      publication = {
        ...publication,
        state: "draft",
      };
    }

    if (publication.state === "draft") {
      deps.log("Draft sealed; publishing it to platform workers.");
      const publishPath = `${publicationPath(config.gameId, accepted.publicationId)}:publish`;
      const published = (
        await managementRequest<BuildPublicationAccepted>(
          deps,
          origin,
          publishPath,
          {
            method: "POST",
            headers: {
              "Idempotency-Key": requestKey(
                "buildpublish",
                config.gameId,
                accepted.publicationId,
                accepted.buildId,
                archive.sha256
              ),
            },
          }
        )
      ).body;
      if (
        published.publicationId !== accepted.publicationId ||
        published.operationId !== accepted.operationId ||
        published.buildId !== accepted.buildId ||
        published.sourceId !== accepted.sourceId ||
        published.state !== "pending"
      ) {
        throw new Error("The published draft identities do not match the source draft.");
      }
      publication = { ...publication, state: "pending" };
    }

    const baseResult: PublishBuildResult = {
      gameId: config.gameId,
      version,
      publicationId: accepted.publicationId,
      operationId: accepted.operationId,
      buildId: accepted.buildId,
      state: publication.state,
      archiveSha256: archive.sha256,
      archiveSizeBytes: archive.sizeBytes,
    };
    if (options.wait === false) return baseResult;

    const startedAt = deps.now();
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    let lastState = "";
    while (deps.now() - startedAt < timeoutMs) {
      publication = (
        await managementRequest<BuildPublication>(
          deps,
          origin,
          publicationPath(config.gameId, accepted.publicationId)
        )
      ).body;
      if (publication.state !== lastState) {
        lastState = publication.state;
        deps.log(`Platform publication: ${publication.state}.`);
      }
      if (publication.state === "failed") {
        throw new Error(
          `Platform workers rejected the build${publication.errorCode ? ` (${publication.errorCode})` : ""}${publication.errorMessage ? `: ${publication.errorMessage}` : "."}`
        );
      }
      if (publication.state === "succeeded") {
        const build = (
          await managementRequest<PublishedBuild>(
            deps,
            origin,
            `/v1/management/games/${encodeURIComponent(config.gameId)}/builds/${encodeURIComponent(accepted.buildId)}`
          )
        ).body;
        if (
          build.id !== accepted.buildId ||
          build.gameId !== config.gameId ||
          build.version !== version ||
          build.status !== "ready"
        ) {
          throw new Error("The platform returned a Build that does not match the submitted draft.");
        }
        return { ...baseResult, state: "succeeded", build };
      }
      if (!ACTIVE_STATES.has(publication.state)) {
        throw new Error(`The platform returned unknown publication state ${publication.state}.`);
      }
      await deps.sleep(pollIntervalMs);
    }
    throw new Error(
      `Timed out waiting for ${accepted.publicationId}. The draft remains durable; rerun the same command to resume it.`
    );
  } finally {
    await archive.cleanup();
  }
}
