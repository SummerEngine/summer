import { stat } from "node:fs/promises";
import { resolveGatewayUrl } from "../config.js";
import { appendStoreJsonLine } from "../store.js";
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
 * client reaches players only when a release of its Build includes it:
 * summer_go_live takes the clientPackageId this answers with.
 *
 * An agent sign-in may declare a client and send its parts freely; the store
 * lets it finish the upload (:complete) only while the person's Agent
 * permissions allow Publish. The preview says so before any byte is sent.
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

const PUBLISH_OFF =
  "An agent sign-in can finish a client upload only while the person's Agent permissions allow Publish. Turn on Publish in Summer Studio (Agent permissions) and run the same command again, or upload this client from Summer Studio.";

/** The store's refusal to let this sign-in act, with what the person can do about it for a client upload. */
function withClientRecovery(error: unknown): unknown {
  if (error instanceof BuildToolError && error.code === "owner_approval_required") {
    return new BuildToolError("owner_approval_required", error.message.replace(` ${error.recovery}`, ""), `Recovery: nothing was published. ${PUBLISH_OFF}`, error.status, error.detail);
  }
  if (error instanceof BuildToolError && error.code === "store_part_upload_failed") {
    return new BuildToolError(error.code, error.message.replace(` ${error.recovery}`, ""), "Recovery: run the same command again; a client's parts are all sent again.", error.status, error.detail);
  }
  return error;
}

/** Whether the person's Agent permissions allow Publish; null when the store does not say. */
async function agentMayPublish(store: Store): Promise<boolean | null> {
  try {
    const grants = await store.call<Record<string, unknown>>("GET", "me/agent-permissions");
    return typeof grants.publish === "boolean" ? grants.publish : null;
  } catch {
    return null; // The preview goes on without it; the store decides at the upload.
  }
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
  const found = await stat(file).catch(() => null);
  if (!found?.isFile()) {
    throw new BuildToolError("file_not_found", `${file} is not a file on this computer.`, "Recovery: pass file as the path of the client archive (.zip).");
  }
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
    // Said before the bytes are sent: a large archive would upload in full and be refused at its last step.
    const publish = await agentMayPublish(store);
    return {
      ok: true,
      status: "confirmation_required",
      target: { ...target, kind: "program" },
      build,
      game,
      ...(publish === false ? { warnings: [`Publish is off in this person's Agent permissions, so the store would refuse the last step of this upload after every byte was sent. ${PUBLISH_OFF}`] } : {}),
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
    // A storage session that ended is opened again once, and every part resent.
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
      // An ended session shows first at storage, which refuses the parts. The store forgets such a
      // session only when asked to complete it, so a failed part still asks, and that answer decides.
      let partsFailed: unknown = null;
      try {
        await uploadParts(
          async (numbers) => readGrants(await store.call("POST", `${clientPath}:signParts`, { body: { parts: numbers.map((n) => ({ partNumber: n, sha256: partHashes[n - 1] })) } })),
          file,
          digest.sizeBytes,
          plan,
          deps
        );
      } catch (error) {
        if (!(error instanceof BuildToolError && error.code === "store_part_upload_failed")) throw error;
        partsFailed = error;
      }
      try {
        client = await store.call<Record<string, any>>("POST", `${clientPath}:complete`, { body: {} });
      } catch (error) {
        if (error instanceof BuildToolError && error.code === "upload_expired" && attempt === 0) continue;
        // The session is alive and a part is missing: the part's own failure is the answer.
        if (partsFailed && error instanceof BuildToolError && error.code === "upload_incomplete") throw partsFailed;
        throw error;
      }
      uploaded = true;
      break;
    }

    const clientPackageId = String(client.id);
    const clientPath = `${clients}/${seg(clientPackageId)}`;

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
      // What releases it: go-live takes the clients to release by id, this one and the other platforms'.
      goLive: { gameId, clients: [clientPackageId] },
      next: done
        ? `Summer admitted this ${platform} client of Build ${buildId}. Nothing is released yet. To release it, call summer_go_live with gameId ${gameId} and clients ["${clientPackageId}"] ` +
          `(from a shell: summer store go-live --game-id ${gameId} --clients ${clientPackageId}); add the clientPackageId of each other platform's client to release them together.`
        : "Summer is still checking this client. Call summer_publish_build again with the same file, buildId, platform, entry and clientVersion to keep waiting; nothing is uploaded twice.",
    };
  } catch (caught) {
    const error = withClientRecovery(caught);
    await appendStoreJsonLine("creator-audit.jsonl", {
      ...audit,
      outcome: "failed",
      code: error instanceof BuildToolError ? error.code : "publish_client_failed",
      status: error instanceof BuildToolError ? error.status ?? null : null,
    });
    throw error;
  }
}
