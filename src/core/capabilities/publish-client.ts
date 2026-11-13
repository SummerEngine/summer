import { resolveGatewayUrl } from "../config.js";
import { appendStoreJsonLine } from "../store.js";
import { recordBuildClient } from "./build-clients.js";
import { checkStoreGame, createStore, hashParts, listGamesOrThrow, normalizeClientVersion, readGrants, storeToken, uploadParts, type PublishBuildDependencies, type Store } from "./publish-build.js";
import { describeFailure } from "./store-checks.js";
import { BuildToolError } from "./summer-bundle.js";

/**
 * A client of a Build whose server is a program (a game not made with Summer
 * Engine): one archive per platform, uploaded to that Build through the same
 * creator store routes as every other upload (/api/creator-store/* ->
 * /v1/management/*):
 *
 *   GET  games/{g}/builds/{b}                             the Build, and the kind of client it takes
 *   POST games/{g}/builds/{b}/client-packages             declare the archive -> the client and its part plan
 *   POST .../client-packages/{c}:signParts                presigned PUT per part, bound to its SHA-256
 *   PUT  <part URL>                                       bytes straight from disk
 *   POST .../client-packages/{c}:complete                 seal it
 *   GET  .../client-packages/{c}                          until Summer has read it: uploaded or rejected
 *
 * The Build decides the kind of client. Summer reads the archive and never
 * runs it; what it admits is the store's rule, so nothing about the archive is
 * judged here and a refusal carries the store's own code and message. A
 * client reaches players only when a release of its Build includes it
 * (summer_go_live).
 */

/** The platforms a program client is uploaded for. */
export const CLIENT_PLATFORMS = ["macos", "windows", "web"] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];
/** The Player Host interface a program client joins through. */
const HOST_INTERFACE = 6;
/** A web client starts at its page. */
const WEB_ENTRY = "index.html";
const PART_BYTES = 64 * 1024 * 1024;
const DEFAULT_WAIT_SECONDS = 600;
const POLL_MS = 3_000;
const seg = encodeURIComponent;

export interface PublishClientInput {
  gameId?: string;
  buildId: string;
  file: string;
  platform?: string;
  entry?: string;
  clientVersion?: string;
  confirm?: boolean;
  waitSeconds?: number;
  face: "cli" | "mcp";
}

export function isClientPlatform(value: string): value is ClientPlatform {
  return (CLIENT_PLATFORMS as readonly string[]).includes(value);
}

/** The Build a client is for, as far as the upload needs it. */
async function readBuild(store: Store, gameId: string, buildId: string): Promise<{ buildId: string; version: string | null; status: string | null; serverKind: "program" | "engine" }> {
  let build: Record<string, any>;
  try {
    build = await store.call<Record<string, any>>("GET", `games/${seg(gameId)}/builds/${seg(buildId)}`);
  } catch (error) {
    if (error instanceof BuildToolError && error.status === 404) {
      throw new BuildToolError(
        "build_not_found",
        `This game has no Build "${buildId}".`,
        "Recovery: pass the buildId the server's upload answered with (summer_publish_build of the server bundle). A Build exists once Summer has made it from that upload.",
        404
      );
    }
    throw error;
  }
  return {
    buildId,
    version: typeof build.version === "string" ? build.version : null,
    status: typeof build.status === "string" ? build.status : null,
    serverKind: build.manifest?.serverKind === "program" ? "program" : "engine",
  };
}

/** Why Summer did not admit a client, with the store's own code and message. */
function rejected(client: Record<string, any>, clientPackageId: string): BuildToolError {
  const code = typeof client.verificationError === "string" && client.verificationError ? client.verificationError : "client_rejected";
  const failure = describeFailure(code, typeof client.verificationMessage === "string" ? client.verificationMessage : null);
  return new BuildToolError(code, failure.message ?? "Summer did not admit this client.", `Recovery: ${failure.fix}`, undefined, {
    clientPackageId,
    failedCheck: { code, owner: failure.owner },
  });
}

export async function publishClient(input: PublishClientInput, deps: PublishBuildDependencies): Promise<Record<string, unknown> & { ok: true; status: string }> {
  const { buildId, file } = input;
  const gameId = input.gameId?.trim();
  const platform = input.platform?.trim();
  if (!platform || !isClientPlatform(platform)) {
    throw new BuildToolError(
      "platform_invalid",
      platform ? `"${platform}" is not a platform a Build's client is uploaded for.` : "platform is required with buildId: the one platform this client archive is for.",
      `Recovery: pass platform as one of ${CLIENT_PLATFORMS.join(", ")}. Without buildId the file is a store download instead.`
    );
  }
  const entry = input.entry?.trim() || (platform === "web" ? WEB_ENTRY : "");
  if (!entry) {
    throw new BuildToolError(
      "entry_required",
      "entry is required: what starts this client, as a path inside the archive.",
      'Recovery: pass entry, for example "MyGame.app" for macOS or "MyGame.exe" for Windows.'
    );
  }
  const clientVersion = normalizeClientVersion(input.clientVersion);
  if (!gameId) return listGamesOrThrow(deps);

  const digest = await hashParts(file, PART_BYTES);
  const target = { gameId, buildId, file, platform, entry, clientVersion, sha256: digest.sha256, sizeBytes: digest.sizeBytes };
  const store = createStore(await resolveGatewayUrl(), await storeToken(deps), deps);

  // The Build says which kind of client it takes; the caller is never asked.
  const game = input.confirm === true ? null : (await checkStoreGame(gameId, [], deps)).game;
  const build = await readBuild(store, gameId, buildId);
  if (build.serverKind !== "program") {
    throw new BuildToolError(
      "build_takes_no_separate_client",
      `Build "${buildId}" has a Summer Engine server, so its client is the pack inside its export. A separate client is uploaded only to a Build whose server is a program.`,
      "Recovery: export the game again and upload that .zip without buildId; it becomes a new Build with its client."
    );
  }
  const declaration = { kind: "program", platform, clientSha256: digest.sha256, clientSize: digest.sizeBytes, version: clientVersion, entry, host: { interface: HOST_INTERFACE } };

  if (input.confirm !== true) {
    return {
      ok: true,
      status: "confirmation_required",
      target: { ...target, kind: "program" },
      build,
      game,
      next: "Show the user this exact game, Build, file, platform, entry, digest, size and version. Only after they approve, call again with confirm=true. Nothing was uploaded.",
    };
  }

  const audit = { at: new Date(deps.now()).toISOString(), operation: "publish_client", face: input.face, ...target };
  await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "started" });
  const clients = `games/${seg(gameId)}/builds/${seg(buildId)}/client-packages`;
  const deadline = deps.now() + (input.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;

  try {
    let client: Record<string, any> = {};
    let uploaded = false;
    // A storage session that expired is opened again once, and every part resent.
    for (let attempt = 0; ; attempt++) {
      // Repeating the declaration answers with the same client, so a retry continues it.
      const declared = await store.call<Record<string, any>>("POST", clients, { body: declaration });
      client = declared.package && typeof declared.package === "object" ? declared.package : {};
      const clientPackageId = String(client.id ?? "");
      if (!clientPackageId) throw new BuildToolError("store_invalid_response", "The store did not return a client id.", "Recovery: retry; the same upload continues.");
      if (client.state !== "awaiting_upload") break;
      const plan = { partSizeBytes: Number(declared.upload?.partSizeBytes), partCount: Number(declared.upload?.partCount) };
      if (!(plan.partSizeBytes > 0) || plan.partCount !== Math.max(1, Math.ceil(digest.sizeBytes / plan.partSizeBytes))) {
        throw new BuildToolError("store_invalid_response", "The store's part plan does not fit this file.", "Recovery: retry; if it repeats, report the store as unhealthy.");
      }
      const clientPath = `${clients}/${seg(clientPackageId)}`;
      const partHashes = plan.partSizeBytes === PART_BYTES ? digest.parts : (await hashParts(file, plan.partSizeBytes)).parts;
      await uploadParts(
        async (numbers) => readGrants(await store.call("POST", `${clientPath}:signParts`, { body: { parts: numbers.map((n) => ({ partNumber: n, sha256: partHashes[n - 1] })) } })),
        file,
        digest.sizeBytes,
        plan,
        deps
      );
      try {
        client = await store.call<Record<string, any>>("POST", `${clientPath}:complete`, { body: {} });
      } catch (error) {
        if (error instanceof BuildToolError && error.code === "upload_expired" && attempt === 0) continue;
        throw error;
      }
      uploaded = true;
      break;
    }

    const clientPackageId = String(client.id);
    const clientPath = `${clients}/${seg(clientPackageId)}`;
    // What go-live releases for this platform, kept even while Summer still reads the bytes.
    await recordBuildClient(gameId, buildId, platform, { clientPackageId, clientVersion, sha256: digest.sha256, recordedAt: new Date(deps.now()).toISOString() });

    // Summer scans the stored bytes and reads the archive; that ends as uploaded or rejected.
    while (client.state !== "uploaded" && client.state !== "rejected" && deps.now() < deadline) {
      await deps.sleep(POLL_MS);
      client = await store.call<Record<string, any>>("GET", clientPath);
    }
    if (client.state === "rejected") throw rejected(client, clientPackageId);

    const done = client.state === "uploaded";
    await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: done ? "succeeded" : "processing", clientPackageId });
    return {
      ok: true,
      status: done ? "uploaded" : "processing",
      gameId,
      buildId,
      clientPackageId,
      kind: "program",
      platform,
      entry,
      clientVersion,
      sha256: digest.sha256,
      sizeBytes: digest.sizeBytes,
      state: client.state ?? null,
      ...(typeof client.qualificationId === "string" && client.qualificationId ? { qualificationId: client.qualificationId } : {}),
      // A wait the store explains, such as a game that is not active right now.
      ...(!done && typeof client.verificationMessage === "string" && client.verificationMessage ? { message: client.verificationMessage } : {}),
      uploaded,
      next: done
        ? `Summer admitted this ${platform} client of Build ${buildId}. Players get it when a release of that Build includes it: upload the other platforms' clients the same way, then call summer_go_live (gameId ${gameId}).`
        : "Summer is still checking this client. Call summer_publish_build again with the same file, buildId, platform, entry and clientVersion to keep waiting; nothing is uploaded twice.",
    };
  } catch (error) {
    await appendStoreJsonLine("creator-audit.jsonl", {
      ...audit,
      outcome: "failed",
      code: error instanceof BuildToolError ? error.code : "publish_client_failed",
      status: error instanceof BuildToolError ? error.status ?? null : null,
    });
    throw error;
  }
}
