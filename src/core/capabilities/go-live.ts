import { createHash } from "node:crypto";
import { resolveGatewayUrl } from "../config.js";
import { appendStoreJsonLine } from "../store.js";
import { createStore, defaultDependencies, listGamesOrThrow, storeToken, type PublishBuildDependencies, type Store } from "./publish-build.js";
import { droppedPlatforms, notUsedPlatforms, serverOnlyRefusal, type DroppedPlatform, type NotUsedPlatform } from "./release-drops.js";
import { describeFailure, summarizeChecks, type ChecksSummary, type PlatformCheck } from "./store-checks.js";
import { BuildToolError } from "./summer-bundle.js";

/**
 * summer_go_live: take a store game live for players over the same creator
 * store routes Studio uses (PSE /api/creator-store/* -> /v1/management/*),
 * then watch until players get it or a check fails.
 *
 *   GET  games/{g}, games/{g}/revisions, games/{g}/review        the page and Summer's review
 *   GET  games/{g}/approval                                       only a sent-back page's decision, on a platform whose /review lacks latestReview
 *   GET  games/{g}/build-publications, store/versions             the uploads and their checks
 *   GET  games/{g}/environments/env_production (+ releases/{id})  what players get now, and a release on its way
 *   POST build-publications/{p}:publish                           a preview Build, made ready for players
 *   POST environments/env_production/release-drafts (+ :publish)  release the Build to players
 *   POST revisions/{r}:publish (If-Match)                         publish the store page
 *
 * A Build whose server is a program (a game not made with Summer Engine) has
 * no client pack on its publication: its clients were uploaded one per
 * platform (macOS, Windows, web), and each is admitted on its own. The call
 * names the clients to release (clients, their ids), and each is read from
 * the store before it is used:
 *
 *   GET  games/{g}/builds/{b}                                     the kind of server the Build has
 *   GET  games/{g}/builds/{b}/client-packages/{c}                 each client the call names
 *
 * Its release is the server, the clients named, and the members of the same
 * Build that players have now and that are not replaced. A platform players
 * have now is never dropped by leaving it out: the call is blocked unless it
 * names the platform in remove. The plan comes from the call's inputs and the
 * store only, so a preview and its confirmation cannot differ.
 *
 * Who can find the store page (Public or Private) is never changed here; the
 * answer says which it is when the store tells.
 *
 * An agent credential may call the three :publish actions without an owner
 * approval while the person's Agent permissions allow Publish (the platform
 * default; summer-platform internal/management/agent_gate.go). The platform
 * runs every automated check, and a game goes live as soon as they pass:
 * Summer's staff review it afterwards (review after live). A staff hold is
 * reported with what to change; a platform hold is reported as Summer's, never
 * as a step the creator waits on. Calling again continues: the same
 * idempotency keys replay what was already asked, so nothing is requested
 * twice.
 */

const ENVIRONMENT = "env_production";
const DEFAULT_WAIT_SECONDS = 600;
const POLL_MS = 10_000;
/** Client platforms a bundle Build is released to (web ships as a store version). */
const RELEASE_PLATFORMS = ["ios", "android", "macos", "windows"];
const INTAKE_DONE = ["preview_ready", "published", "ready", "succeeded"];
const SENT_BACK = ["CHANGES_REQUESTED", "REJECTED"];
const PUBLISHABLE = ["DRAFT", "SUBMITTED", "VERIFYING", "APPROVED"];
const seg = encodeURIComponent;
/** The creator store proxy sends this header on as If-Match. */
const REVISION_HEADER = "x-summer-revision";

export interface GoLiveInput {
  gameId?: string;
  /** The bundle Build to release (build-publications id). Default: the newest export that passed its checks. */
  publicationId?: string;
  /** A Build whose server is a program: the ids of its clients to release (clientPackageId from each client's upload). */
  clients?: string[];
  /** A Build whose server is a program: platforms players have now to take out of the release on purpose. */
  remove?: string[];
  confirm?: boolean;
  waitSeconds?: number;
  face: "cli" | "mcp";
}

export type GoLiveResult = Record<string, unknown> & { ok: true; status: string };

/** Text the store page must have before it can be published (summer-platform internal/creatorcatalog). */
const PAGE_FIXES: Record<string, string> = {
  name: "Give the page a title: store.update_listing title.",
  description: "Write the short description: store.update_listing desktop.description.",
  supportedPlatforms: "List the platforms players can play on: store.update_listing targets.",
  contentRating: "Pick a content rating (everyone, everyone10Plus or teen): store.update_listing contentRating.",
  contentDescriptors: "Answer the content descriptors, an empty list when none apply: store.update_listing contentDescriptors.",
  mediaSlots: "An art slot holds the wrong kind or shape of image: fix it with store.set_art (the store-art skill has each slot's size).",
  media: "An image or video is still being checked or was refused: wait a minute, then read store.get_listing and replace a refused one with store.set_art.",
};

interface PageState {
  revisionId: string;
  state: string;
  etag: number;
  name: string | null;
  platforms: string[];
  problems: Array<{ field: string; fix: string }>;
}

interface BuildState {
  publicationId: string;
  buildId: string | null;
  version: string | null;
  state: string;
  hosted: boolean | null;
  checks: ReturnType<typeof summarizeChecks>;
  /** Players get this Build now on these platforms. */
  livePlatforms: string[];
  failure?: ReturnType<typeof describeFailure>;
  /** Set when the Build's server is a program: its clients, not a client pack, are released. */
  serverKind?: "program";
  /** A program Build's release, as the call's inputs and the store give it. */
  plan?: ProgramPlan;
}

/** One platform's client in the release of a Build whose server is a program. */
interface ProgramMember {
  platform: string;
  /** clients: named by this call; live: the member players have now, kept as it is. */
  from: "clients" | "live";
  /** Null for a kept member: the release names it by its qualification. */
  clientPackageId: string | null;
  /** Null while Summer still reads a named client. */
  qualificationId: string | null;
  version: string | null;
}

interface ProgramPlan {
  /** Exactly what players will have per platform once this is released. */
  members: ProgramMember[];
  /** Platforms players have now that this release takes out, because the call named them in remove. */
  removed: string[];
  /** Why the plan cannot be released as asked: a client the store does not have or did not admit, a platform that would be lost. */
  problems: Array<Record<string, unknown>>;
}

interface Snapshot {
  game: Record<string, any>;
  page: PageState | null;
  /** Summer's review (GET games/{g}/review); null on a platform that predates it. */
  review: Record<string, any> | null;
  /** The newest decision on the store page: /review's latestReview, else the deprecated /approval's (read only for a sent-back page). */
  latestReview: Record<string, any> | null;
  build: BuildState | null;
  environment: Record<string, any> | null;
  release: Record<string, any> | null;
  /** The release on its way (the environment's desired release, while it is not the active one). */
  pending: Record<string, any> | null;
  /** Client platforms the release left out (the pending release's, else the active one's); none on a platform before SUM-1107. */
  dropped: DroppedPlatform[];
  /** Newer clients the release did not use: those platforms stay live with their current client. */
  notUsed: NotUsedPlatform[];
  versions: Array<{ platform: string; status: string; reason?: string }>;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

function keyOf(gameId: string, ...parts: string[]): string {
  return createHash("sha256").update(["go-live", gameId, ...parts].join(":")).digest("hex");
}

async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof BuildToolError && (error.status === 404 || error.code === "store_not_found")) return null;
    throw error;
  }
}

function pageOf(revision: Record<string, any> | null): PageState | null {
  if (!revision || typeof revision.revisionId !== "string") return null;
  const name = text(revision.presentation?.name) ?? text(revision.name);
  const description = text(revision.presentation?.description) ?? text(revision.description);
  const platforms = Array.isArray(revision.supportedPlatforms) ? revision.supportedPlatforms.filter((value: unknown): value is string => typeof value === "string") : [];
  const problems: PageState["problems"] = [];
  if (!name) problems.push({ field: "name", fix: PAGE_FIXES.name });
  if (!description) problems.push({ field: "description", fix: PAGE_FIXES.description });
  if (!platforms.length) problems.push({ field: "supportedPlatforms", fix: PAGE_FIXES.supportedPlatforms });
  if (!text(revision.contentRating)) problems.push({ field: "contentRating", fix: PAGE_FIXES.contentRating });
  if (revision.contentDescriptors == null) problems.push({ field: "contentDescriptors", fix: PAGE_FIXES.contentDescriptors });
  return { revisionId: revision.revisionId, state: String(revision.state ?? ""), etag: Number(revision.etagRevision ?? 0), name, platforms, problems };
}

function newest<T extends Record<string, any>>(items: T[], order: (item: T) => number): T | null {
  return items.reduce<T | null>((best, item) => (!best || order(item) > order(best) ? item : best), null);
}

const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) || 0 : 0);

/** The players' side of a Build: on which platforms the active release serves it. */
function livePlatformsOf(release: Record<string, any> | null, buildId: string | null): string[] {
  if (!release || !buildId || release.status !== "active" || !Array.isArray(release.targets)) return [];
  return release.targets.filter((target: Record<string, any>) => target?.buildId === buildId).map((target: Record<string, any>) => String(target.target));
}

/** What a call asks of a Build whose server is a program. */
interface ProgramSelection {
  clients: string[];
  remove: string[];
}

const clean = (values: string[] | undefined) => [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];

/** A platform's name as the creator reads it. */
const NAMED: Record<string, string> = { macos: "macOS", windows: "Windows", web: "Web", ios: "iOS", android: "Android", linux: "Linux" };
const named = (platform: string) => NAMED[platform] ?? platform;

/**
 * The release of a Build whose server is a program, or null for any other
 * Build: the clients the call names, each read from the store and held to
 * this Game and Build, plus the members of this Build that players have now
 * and that are not replaced. A named client the store does not have here, did
 * not admit, or that is not a client of a program is a problem, by name. So
 * is a platform players have now that the release would leave without a
 * client and that the call does not name in remove. A platform is live when
 * players have exactly the client the plan names.
 */
async function programPlan(
  store: Store,
  gameId: string,
  buildId: string,
  release: Record<string, any> | null,
  selection: ProgramSelection
): Promise<{ checks: ChecksSummary; plan: ProgramPlan; livePlatforms: string[] } | null> {
  const detail = await optional(() => store.call<Record<string, any>>("GET", `games/${seg(gameId)}/builds/${seg(buildId)}`));
  if (detail?.manifest?.serverKind !== "program") return null;
  // What players have now, on every platform; the members of this Build can be kept as they are.
  const live: Array<Record<string, any>> = release?.status === "active" && Array.isArray(release.targets) ? release.targets.filter((target: Record<string, any>) => typeof target?.target === "string" && target.target !== "server") : [];
  const problems: Array<Record<string, unknown>> = [];
  const checks: PlatformCheck[] = [];
  const chosen = new Map<string, ProgramMember>();

  for (const clientPackageId of selection.clients) {
    const field = `client ${clientPackageId}`;
    const client = await optional(() => store.call<Record<string, any>>("GET", `games/${seg(gameId)}/builds/${seg(buildId)}/client-packages/${seg(clientPackageId)}`));
    const platform = text(client?.platform);
    if (!client || client.kind !== "program" || !platform) {
      problems.push({
        field,
        code: "client_not_found",
        fix: `"${clientPackageId}" is not a client of Build ${buildId} of this game. Pass the clientPackageId each client's upload answered with (summer_publish_build with buildId); for clients of another Build, pass that Build's publicationId too.`,
      });
      continue;
    }
    if (chosen.has(platform)) {
      problems.push({ field, code: "client_platform_repeated", fix: `Two of the clients named are for ${named(platform)}: "${chosen.get(platform)!.clientPackageId}" and "${clientPackageId}". Pass one client per platform.` });
      continue;
    }
    const qualificationId = client.state === "uploaded" ? text(client.qualificationId) : null;
    chosen.set(platform, { platform, from: "clients", clientPackageId, qualificationId, version: text(client.version) });
    if (qualificationId) checks.push({ platform, state: "passed" });
    else if (client.state === "rejected") {
      const failure = describeFailure(text(client.verificationError) ?? "client_rejected", text(client.verificationMessage));
      checks.push({ platform, state: "failed", ...failure });
      problems.push({ field, platform, ...failure });
    } else checks.push({ platform, state: "checking", ...(text(client.verificationMessage) ? { message: String(client.verificationMessage) } : {}) });
  }

  for (const platform of selection.remove) {
    if (chosen.has(platform)) problems.push({ field: `platform ${platform}`, code: "remove_conflicts_with_client", fix: `${named(platform)} is named in remove and a client for it is named in clients. Keep one of the two.` });
  }

  const members: ProgramMember[] = [];
  const removed: string[] = [];
  const livePlatforms: string[] = [];
  for (const platform of new Set([...chosen.keys(), ...live.map((target) => String(target.target))])) {
    const now = live.find((target) => target.target === platform);
    const mine = now && now.buildId === buildId ? now : null;
    if (selection.remove.includes(platform)) {
      if (now) removed.push(platform);
      continue;
    }
    const client = chosen.get(platform);
    if (client) {
      members.push(client);
      if (mine && client.qualificationId && mine.qualificationId === client.qualificationId) livePlatforms.push(platform);
    } else if (mine && text(mine.qualificationId)) {
      members.push({ platform, from: "live", clientPackageId: null, qualificationId: text(mine.qualificationId), version: null });
      livePlatforms.push(platform);
    } else {
      // Players have this platform from another Build, and this release has no client for it.
      problems.push({
        field: `platform ${platform}`,
        code: "platform_would_be_removed",
        fix:
          `${named(platform)} is live now with a client of another Build, and this release has no client of Build ${buildId} for it, so its players would lose the game. ` +
          `Upload one (summer_publish_build with buildId ${buildId}, platform ${platform}) and name it in clients, or name ${platform} in remove to take it out on purpose.`,
      });
    }
  }
  if (!members.length && !problems.length) {
    problems.push({
      field: "build",
      code: "client_required",
      fix:
        `This Build's server is a program, and no client of it is named or live, so players would have nothing to start. Upload one archive per platform with summer_publish_build ` +
        `(buildId ${buildId}, platform macos, windows or web, entry, clientVersion), then call summer_go_live again with clients: the clientPackageId of each.`,
    });
  }
  const state = checks.some((check) => check.state === "checking") ? "checking" : checks.some((check) => check.state === "failed") ? "failed" : "passed";
  return { checks: { state, checks }, plan: { members, removed, problems }, livePlatforms };
}

/** What go-live asked for: the release it requested, the platforms its answer left out, and a refusal of the release. */
interface Requested {
  releaseId: string | null;
  dropped: DroppedPlatform[];
  notUsed: NotUsedPlatform[];
  /** The platform refused the release; its message, when it gave one. */
  refused: { message: string | null } | null;
  /** A program Build's release that the store refused whole because of one of its clients: its code and message. */
  clientRefused: { code: string; message: string | null } | null;
  /** Platforms the requested release took out on purpose (remove). */
  removed: string[];
}

const fresh = (): Requested => ({ releaseId: null, dropped: [], notUsed: [], refused: null, clientRefused: null, removed: [] });

/**
 * A store page whose platforms the release cannot serve keeps the previous
 * release. The platform's message says what to do (a build with the apps, or
 * the server too); without one, the creator uploads a build with the apps.
 */
const serverOnlyFailure = (message?: unknown) => ({
  field: "build",
  code: "playable_release_required",
  fix: `${serverOnlyRefusal(message)} Then call summer_go_live again (or set release stage coming_soon with store.update_listing).`,
});

async function read(store: Store, gameId: string, publicationId: string | undefined, selection: ProgramSelection, requested: Requested = fresh()): Promise<Snapshot> {
  const game = await store.call<Record<string, any>>("GET", `games/${seg(gameId)}`);
  const [revisions, review, publications, versions, environment] = await Promise.all([
    store.call<{ items?: Array<Record<string, any>> }>("GET", `games/${seg(gameId)}/revisions?limit=20`),
    optional(() => store.call<Record<string, any>>("GET", `games/${seg(gameId)}/review`)),
    store.call<{ items?: Array<Record<string, any>> }>("GET", `games/${seg(gameId)}/build-publications`),
    optional(() => store.call<{ items?: Array<Record<string, any>> }>("GET", `games/${seg(gameId)}/store/versions`)),
    optional(() => store.call<Record<string, any>>("GET", `games/${seg(gameId)}/environments/${ENVIRONMENT}`)),
  ]);
  const page = pageOf(newest(revisions.items ?? [], (item) => Number(item.sequence ?? 0)));
  const latestReview = await latestReviewOf(store, gameId, review, page);
  const release = environment?.activeReleaseId
    ? await optional(() => store.call<Record<string, any>>("GET", `games/${seg(gameId)}/environments/${ENVIRONMENT}/releases/${seg(String(environment.activeReleaseId))}`))
    : null;
  // The release on its way; once the platform gives up on it (desiredReleaseId cleared), the one go-live asked for, to read why.
  const pendingId = environment?.desiredReleaseId && environment.desiredReleaseId !== environment.activeReleaseId
    ? String(environment.desiredReleaseId)
    : requested.releaseId && requested.releaseId !== environment?.activeReleaseId ? requested.releaseId : null;
  const pending = pendingId ? await optional(() => store.call<Record<string, any>>("GET", `games/${seg(gameId)}/environments/${ENVIRONMENT}/releases/${seg(pendingId)}`)) : null;
  const listed = droppedPlatforms((pending ?? release)?.droppedTargets);
  const dropped = listed.length ? listed : requested.dropped;
  const unused = notUsedPlatforms((pending ?? release)?.notUsedTargets);
  const notUsed = unused.length ? unused : requested.notUsed;

  const exported = (publications.items ?? []).filter((item) => item?.source?.kind === "exported-game" || item?.source?.kind === undefined);
  let chosen: Record<string, any> | null = null;
  if (publicationId) {
    chosen = await store.call<Record<string, any>>("GET", `games/${seg(gameId)}/build-publications/${seg(publicationId)}`);
  } else {
    const candidate = newest(
      exported.filter((item) => !["failed", "cancelled"].includes(item.state)),
      (item) => time(item.createdAt ?? item.updatedAt)
    );
    // The list may leave the client pack out: read the chosen one in full.
    chosen = candidate ? await store.call<Record<string, any>>("GET", `games/${seg(gameId)}/build-publications/${seg(String(candidate.id ?? candidate.publicationId))}`) : null;
  }
  let build: BuildState | null = null;
  if (chosen) {
    const buildId = text(chosen.buildId);
    const failed = chosen.state === "failed" || chosen.state === "cancelled";
    // A Summer Engine export always names a client version; a bundle whose server is a program never
    // does. Only a finished publication without one, and without a client pack, is asked what its
    // Build's server is, so an Engine Build costs no request here and no answer of its changes.
    const candidate = buildId && INTAKE_DONE.includes(String(chosen.state)) && !chosen.clientPackage && !text(chosen.clientVersion);
    const program = candidate ? await programPlan(store, gameId, buildId, release, selection) : null;
    build = {
      publicationId: String(chosen.id ?? chosen.publicationId ?? publicationId),
      buildId,
      version: text(chosen.clientVersion) ?? text(chosen.version),
      state: String(chosen.state ?? ""),
      hosted: chosen.build?.executionMode ? chosen.build.executionMode === "hosted" : null,
      checks: program ? program.checks : summarizeChecks(chosen),
      livePlatforms: program ? program.livePlatforms : livePlatformsOf(release, buildId),
      ...(failed ? { failure: describeFailure(text(chosen.errorCode), text(chosen.errorMessage)) } : {}),
      ...(program ? { serverKind: "program" as const, plan: program.plan } : {}),
    };
  }
  const versionRows = (versions?.items ?? []).map((item) => ({
    platform: String(item.platform ?? ""),
    status: String(item.status ?? ""),
    ...(text(item.rejectionReason) ? { reason: String(item.rejectionReason) } : {}),
  }));
  return { game, page, review, latestReview, build, environment, release, pending, dropped, notUsed, versions: versionRows };
}

/**
 * The decision on a sent-back store page. /review carries it as latestReview;
 * a platform that predates that field only has it on the deprecated /approval,
 * read best effort: a missing decision still reports the page as sent back.
 */
async function latestReviewOf(store: Store, gameId: string, review: Record<string, any> | null, page: PageState | null): Promise<Record<string, any> | null> {
  if (review?.latestReview && typeof review.latestReview === "object") return review.latestReview;
  if (!page || !SENT_BACK.includes(page.state)) return null;
  try {
    const approval = await store.call<Record<string, any>>("GET", `games/${seg(gameId)}/approval`);
    return approval?.latestReview && typeof approval.latestReview === "object" ? approval.latestReview : null;
  } catch {
    return null;
  }
}

const STILL_CHECKING = "Summer is still checking this; nothing to do on your side.";

/** When a Publish's automated checks have run over an hour, the platform says since when. */
const stillCheckingSince = (snapshot: Snapshot): string | null => text(snapshot.review?.stillCheckingSince);

/** What the platform is waiting on, said so an agent never tells a creator to wait for a review. */
function summerHold(snapshot: Snapshot): Record<string, unknown> {
  const since = stillCheckingSince(snapshot);
  return {
    by: "summer",
    ...(since ? { stillCheckingSince: since } : {}),
    message: since
      ? `${STILL_CHECKING} This request stays in place and goes live by itself once the checks finish.`
      : "Every automated check passed and the platform has not released it yet. That is on Summer's side and needs nothing from you: " +
        "this request stays in place and goes live by itself. (If the server asks for outbound HTTP, Summer staff approve that before it goes live.)",
  };
}

/**
 * Summer staff put the live game on hold after reviewing it and asked for
 * changes. Only a newer store page published now lifts the hold, so this is
 * reported while the newest page is the one staff reviewed; once the creator
 * has made a newer draft, go-live publishes it.
 */
function onHold(snapshot: Snapshot): GoLiveResult | null {
  const review = snapshot.review;
  if (review?.outcome !== "rejected" || !snapshot.page || snapshot.page.revisionId !== review.reviewedRevisionId) return null;
  return {
    ok: true,
    status: "on_hold",
    ...view(snapshot),
    review: { outcome: "rejected", message: text(review.message) },
    next: text(review.message)
      ? "Summer reviewed this live game and put it on hold until these changes are made: review.message. Make them with store.update_listing (a new draft), then call summer_go_live again; publishing the newer store page lifts the hold. A new build alone does not."
      : "Summer reviewed this live game and put it on hold without a written note: tell the owner and ask what to change; then edit with store.update_listing and call summer_go_live again.",
  };
}

function sentBack(snapshot: Snapshot): GoLiveResult | null {
  const review = snapshot.latestReview;
  if (!snapshot.page || !SENT_BACK.includes(snapshot.page.state)) return null;
  return {
    ok: true,
    status: "needs_changes",
    gameId: snapshot.game.id ?? null,
    page: { revisionId: snapshot.page.revisionId, state: snapshot.page.state },
    decision: review ? { decision: review.decision ?? null, decidedBy: review.decidedBy ?? null, feedback: text(review.feedback) } : null,
    next: text(review?.feedback)
      ? "Fix every point in decision.feedback with store.update_listing (it starts a new draft), then call summer_go_live again."
      : "Summer's automatic checks found a problem with this store page: read store.status for what failed, fix it with store.update_listing, then call summer_go_live again.",
  };
}

/** Which client platforms of the Build passed and may be released, and which did not. */
function releasable(build: BuildState): { targets: string[]; held: PlatformCheck[] } {
  // A program Build releases its plan: each platform whose client Summer admitted, the browser's included.
  if (build.plan) return { targets: build.plan.members.filter((member) => member.qualificationId).map((member) => member.platform), held: build.checks.checks.filter((check) => check.state === "failed") };
  const passed = build.checks.checks.filter((check) => check.state === "passed" && RELEASE_PLATFORMS.includes(check.platform)).map((check) => check.platform);
  return { targets: passed, held: build.checks.checks.filter((check) => check.state === "failed") };
}

function view(snapshot: Snapshot) {
  const { page, build } = snapshot;
  return {
    // storeVisibility (public or private) is the store's, as the game read carries it; this never changes it.
    game: { gameId: snapshot.game.id ?? null, name: text(snapshot.game.name), ...(text(snapshot.game.storeVisibility) ? { storeVisibility: snapshot.game.storeVisibility } : {}) },
    page: page ? { revisionId: page.revisionId, state: page.state, name: page.name, platforms: page.platforms, live: page.state === "PUBLISHED" } : null,
    build: build
      ? {
          publicationId: build.publicationId,
          buildId: build.buildId,
          version: build.version,
          state: build.state,
          checksState: build.failure ? "failed" : build.checks.state,
          checks: build.checks.checks,
          livePlatforms: build.livePlatforms,
          ...(build.failure ? { failure: build.failure } : {}),
          // A program Build: exactly what players will have per platform, and what this release takes out.
          ...(build.plan ? { serverKind: "program", willBeLive: build.plan.members, removed: build.plan.removed } : {}),
        }
      : null,
    downloads: snapshot.versions,
    ...(snapshot.dropped.length ? { notIncluded: snapshot.dropped } : {}),
    ...(snapshot.notUsed.length ? { notUsed: snapshot.notUsed } : {}),
    review: snapshot.review
      ? { outcome: text(snapshot.review.outcome), takenDown: snapshot.review.takenDown === true, ...(stillCheckingSince(snapshot) ? { stillCheckingSince: stillCheckingSince(snapshot) } : {}) }
      : null,
  };
}

function isLive(snapshot: Snapshot): boolean {
  if (snapshot.page?.state !== "PUBLISHED") return false;
  if (!snapshot.build) return true;
  // A platform the release left out, or kept on its current client, never gets this Build: it is reported, not waited for.
  const reported = [...snapshot.dropped, ...snapshot.notUsed].map((item) => item.platform);
  // A program Build is live when players have exactly its plan: every member, nothing left to take out, and nothing the call asked for refused.
  const plan = snapshot.build.plan;
  if (plan && (plan.problems.length || plan.removed.length || plan.members.some((member) => !member.qualificationId))) return false;
  const wanted = releasable(snapshot.build).targets.filter((platform) => !reported.includes(platform));
  return wanted.length > 0 && wanted.every((platform) => snapshot.build!.livePlatforms.includes(platform));
}

/**
 * What "live" means for this game, said so it is true whoever can open the page: a Private page is
 * live for its team, the players who own it and its testers only.
 */
function liveLine(snapshot: Snapshot): string {
  const visibility = text(snapshot.game.storeVisibility);
  if (visibility === "private") return "Live. The store page is Private: only the game's team, players who own it and invited testers can open it, and they get it now.";
  const confirm = "Confirm it as a player on summer.games and in the Summer Games apps.";
  return visibility === "public" ? `Live: players get it now. ${confirm}` : `Live: everyone who can see the store page gets it now. ${confirm}`;
}

/** The answer's view after a release was asked: what that release took out stays named once it is gone. */
function viewAfter(snapshot: Snapshot, requested: Requested): ReturnType<typeof view> {
  const shown = view(snapshot);
  if (!requested.removed.length || !shown.build || !snapshot.build?.plan) return shown;
  return { ...shown, build: { ...shown.build, removed: requested.removed } };
}

/** The creator-facing line for the platforms a release left out, or "". */
function droppedLine(snapshot: Snapshot): string {
  const dropped = snapshot.dropped.length ? ` Not included: ${snapshot.dropped.map((drop) => drop.message).join(" ")}` : "";
  const unused = snapshot.notUsed.length ? ` Not used: ${snapshot.notUsed.map((item) => item.message).join(" ")}` : "";
  return dropped + unused;
}

/** Refusals no publish call can get past: each is a fix for the creator. */
function blockers(snapshot: Snapshot): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (snapshot.review?.takenDown === true) {
    out.push({ field: "game", code: "taken_down", ...(text(snapshot.review.message) ? { message: snapshot.review.message } : {}), fix: "Summer took this game down: players can't find or play it. Your builds and private versions are kept. Read the message, and contact Summer support to have it restored." });
  }
  if (!snapshot.page) out.push({ field: "store page", fix: "This game has no store page yet: create it with games.create, or fill it with store.update_listing." });
  for (const problem of snapshot.page?.problems ?? []) out.push(problem);
  const build = snapshot.build;
  if (build?.failure) out.push({ field: "build", ...build.failure });
  if (build?.checks.packFailure) out.push({ field: "build", ...build.checks.packFailure });
  if (build?.plan && !build.failure) {
    // Each is refused by name, before anything is asked of the store: a client it does not have for
    // this Build or did not admit, and a platform players would lose.
    for (const problem of build.plan.problems) out.push(problem);
  } else if (build && !build.failure && build.checks.state !== "checking" && releasable(build).targets.length === 0) {
    out.push({ field: "build", code: "no_platform_passed", fix: "No phone or desktop platform of this Build passed its checks. Apply each check's fix, export again and upload with summer_publish_build." });
    for (const check of releasable(build).held) out.push({ field: `build ${check.platform}`, ...check });
  }
  // The release go-live asked for was refused: the page lists only platforms it left out.
  if (snapshot.pending?.rollout?.errorCode === "playable_release_required") out.push(serverOnlyFailure(snapshot.pending.rollout.message));
  for (const version of snapshot.versions.filter((row) => row.status === "rejected")) {
    out.push({ field: `download ${version.platform}`, code: "store_version_rejected", ...(version.reason ? { message: version.reason } : {}), fix: "Fix what the reason names, export the download again and upload it with summer_publish_build." });
  }
  return out;
}

function permissionRefused(): GoLiveResult {
  return {
    ok: true,
    status: "needs_permission",
    next:
      "Nothing went live: the person's Agent permissions do not let this agent publish. Ask them to turn on Publish (Studio > Agent permissions) and call summer_go_live again, " +
      "or send them the approval link store.publish returns.",
  };
}

/** The store's refusals of a whole release because of one client in it. */
const CLIENT_REFUSALS = ["web_client_game_priced", "draft_not_ready"];

/** What to tell the creator when the store refuses a release because of one of its clients. */
function clientRefusal(refused: { code: string; message: string | null }): Record<string, unknown> {
  return {
    field: "release",
    code: refused.code,
    ...(refused.message ? { message: refused.message } : {}),
    fix:
      refused.code === "web_client_game_priced"
        ? "A game with a price cannot have a browser build yet. Remove the price, or call summer_go_live again without the web client in clients (and with web in remove when players have a browser build now)."
        : "The store will not release one of the clients named, and its message says which platform. Upload that platform's client again as a new clientVersion and name the new one, or call summer_go_live again without it.",
  };
}

/** Make the Build ready for players and ask for its release; returns a hold when the platform declines. */
async function releaseBuild(store: Store, gameId: string, snapshot: Snapshot, deps: PublishBuildDependencies, deadline: number, requested: Requested): Promise<Record<string, unknown> | null> {
  const build = snapshot.build!;
  const { targets } = releasable(build);
  // Nothing to ask when players have every platform of this Build already; a program Build's plan may still take one out.
  if (!build.buildId || !targets.length || (targets.every((platform) => build.livePlatforms.includes(platform)) && !build.plan?.removed.length)) return null;
  const publicationPath = `games/${seg(gameId)}/build-publications/${seg(build.publicationId)}`;
  let detail = await store.call<Record<string, any>>("GET", `games/${seg(gameId)}/builds/${seg(build.buildId)}`);
  if (detail.status === "preview_ready") {
    try {
      await store.call("POST", `${publicationPath}:publish`, { body: {}, key: keyOf(gameId, "prepare", build.publicationId) });
    } catch (error) {
      if (error instanceof BuildToolError && error.status === 409 && error.code === "deployment_not_actionable") return summerHold(snapshot);
      throw error;
    }
    while (detail.status !== "ready" && deps.now() < deadline) {
      await deps.sleep(POLL_MS);
      detail = await store.call<Record<string, any>>("GET", `games/${seg(gameId)}/builds/${seg(build.buildId)}`);
      if (detail.status === "failed") throw new BuildToolError("build_failed", "Summer could not prepare this Build for players.", "Recovery: export again and upload with a new clientVersion.");
    }
    if (detail.status !== "ready") return { by: "summer", message: "Summer is preparing the Build for players." };
  }
  const environment = snapshot.environment;
  if (environment?.desiredReleaseId && environment.desiredReleaseId !== environment.activeReleaseId) return null; // a release is already on its way
  const selection: Record<string, Record<string, string>> = {};
  const hosted = (detail.executionMode ?? (build.hosted ? "hosted" : "standalone")) === "hosted";
  if (hosted) selection.server = { buildId: build.buildId, qualificationId: "" };
  if (build.plan) {
    // The whole release, member by member: a named client by its upload and the qualification it earned,
    // a kept one by the qualification players have now. Listing all of them is what keeps a platform.
    // In platform order, so the same members are the same request whatever order the call named them in.
    for (const member of [...build.plan.members].sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0))) {
      if (!member.qualificationId) continue;
      const target: Record<string, string> = { buildId: build.buildId, qualificationId: member.qualificationId };
      if (member.clientPackageId) target.uploadId = member.clientPackageId;
      selection[member.platform] = target;
    }
  } else {
    const pack = (await store.call<Record<string, any>>("GET", publicationPath)).clientPackage ?? {};
    for (const platform of targets) {
      const check = (pack.verifications ?? []).find((row: Record<string, any>) => row.platform === platform && row.state === "ready" && row.qualificationId);
      if (check) selection[platform] = { buildId: build.buildId, uploadId: String(pack.id), qualificationId: String(check.qualificationId) };
    }
  }
  // An Engine Build's members follow from its publication. A program Build's are the call's choice, so
  // its keys cover them: another choice after a refused release is another request, not a replay.
  const chosen = build.plan ? [createHash("sha256").update(JSON.stringify(Object.keys(selection).sort().map((name) => [name, selection[name]!.uploadId ?? "", selection[name]!.qualificationId]))).digest("hex")] : [];
  const base = `${environment?.revision ?? 0}:${environment?.activeReleaseId ?? ""}`;
  const draft = await store.call<Record<string, any>>("POST", `games/${seg(gameId)}/environments/${ENVIRONMENT}/release-drafts`, {
    body: { title: build.version ?? "Release", notes: "", targets: selection },
    key: keyOf(gameId, "draft", build.publicationId, base, ...chosen),
  });
  let accepted: Record<string, any> | null;
  try {
    accepted = await store.call<Record<string, any>>("POST", `games/${seg(gameId)}/environments/${ENVIRONMENT}/release-drafts/${seg(String(draft.id))}:publish`, {
      body: { targets: Object.keys(selection), replaceTargets: true },
      key: keyOf(gameId, "release", build.publicationId, base, ...chosen),
      // The proxy forwards x-summer-revision as If-Match (it passes no other header but idempotency-key).
      headers: { [REVISION_HEADER]: `"${draft.revision}"` },
    });
  } catch (error) {
    if (error instanceof BuildToolError && error.code === "playable_release_required") {
      requested.refused = { message: text(error.detail?.message) };
      return null;
    }
    // The store read a named client as admitted and still will not release it (a browser build of a game
    // that has a price, a client Summer withdrew). Nothing was released; its own words say which.
    if (build.plan && error instanceof BuildToolError && error.status === 409 && CLIENT_REFUSALS.includes(error.code)) {
      requested.clientRefused = { code: error.code, message: text(error.message.replace(` ${error.recovery}`, "")) };
      return null;
    }
    throw error;
  }
  requested.removed = build.plan?.removed ?? [];
  requested.releaseId = text(accepted?.releaseId);
  requested.dropped = droppedPlatforms(accepted?.droppedTargets);
  requested.notUsed = notUsedPlatforms(accepted?.notUsedTargets);
  return null;
}

/** Publish the store page revision; returns a result to answer with when the platform refuses it. */
async function publishPage(store: Store, gameId: string, snapshot: Snapshot): Promise<GoLiveResult | null> {
  const page = snapshot.page!;
  if (!PUBLISHABLE.includes(page.state)) return null;
  try {
    await store.call("POST", `games/${seg(gameId)}/revisions/${seg(page.revisionId)}:publish`, {
      body: {},
      key: keyOf(gameId, "page", page.revisionId),
      headers: { [REVISION_HEADER]: `"game-revision:${page.revisionId}:${page.etag}"` },
    });
  } catch (error) {
    if (!(error instanceof BuildToolError)) throw error;
    // Already asked (a replay, or a request in flight): keep watching it.
    if (error.status === 409 && ["publication_in_progress", "idempotency_conflict"].includes(error.code)) return null;
    if (error.code === "owner_approval_required") return permissionRefused();
    if (error.code === "store_page_incomplete") {
      const missing = Array.isArray(error.detail?.missing) ? (error.detail!.missing as string[]) : [];
      return {
        ok: true,
        status: "blocked",
        gameId,
        failures: missing.map((field) => ({ field, fix: PAGE_FIXES[field] ?? "Finish this field of the store page with store.update_listing." })),
        next: "Fix each failure, then call summer_go_live again.",
      };
    }
    if (error.code === "playable_release_required") {
      return {
        ok: true,
        status: "blocked",
        gameId,
        failures: [serverOnlyFailure(error.detail?.message)],
        next: `${serverOnlyRefusal(error.detail?.message)} Then call summer_go_live again.`,
      };
    }
    throw error;
  }
  return null;
}

export async function goLive(input: GoLiveInput, overrides: Partial<PublishBuildDependencies> = {}): Promise<GoLiveResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const gameId = input.gameId?.trim();
  if (!gameId) return listGamesOrThrow(deps);
  const store = createStore(await resolveGatewayUrl(), await storeToken(deps), deps);
  const deadline = deps.now() + Math.min(Math.max(input.waitSeconds ?? DEFAULT_WAIT_SECONDS, 0), 1800) * 1000;
  // The clients to release and the platforms to take out are this call's own inputs: nothing else decides them.
  const selection: ProgramSelection = { clients: clean(input.clients), remove: clean(input.remove) };
  let snapshot = await read(store, gameId, input.publicationId, selection);
  if ((selection.clients.length || selection.remove.length) && !snapshot.build?.plan) {
    throw new BuildToolError(
      "clients_not_applicable",
      "clients and remove choose the clients of a Build whose server is a program, once Summer has made it. " +
        (snapshot.build ? `The Build of publication ${snapshot.build.publicationId} is not one: a Summer Engine Build's platforms follow from its export.` : "This game has no uploaded Build."),
      "Recovery: call again without clients and remove, or pass publicationId of the Build those clients were uploaded to."
    );
  }

  const held = onHold(snapshot);
  if (held) return held;
  const back = sentBack(snapshot);
  if (back) return back;
  if (isLive(snapshot)) return { ok: true, status: "live", ...view(snapshot), next: liveLine(snapshot) };
  const stops = blockers(snapshot);
  if (stops.length) return { ok: true, status: "blocked", ...view(snapshot), failures: stops, next: "Fix each failure, then call summer_go_live again." };

  if (input.confirm !== true) {
    return {
      ok: true,
      status: "confirmation_required",
      ...view(snapshot),
      next: snapshot.build?.plan
        ? "Show the user this exact game, store page and build: build.willBeLive is what players will have on each platform (from clients: a client this call names; from live: the one they have now, kept), and build.removed what is taken out. Only after they approve going live, call again with confirm=true and the same clients and remove. Nothing was published."
        : "Show the user this exact game, store page and build (version and platforms). Only after they approve going live, call again with confirm=true. Nothing was published.",
    };
  }

  const audit = {
    at: new Date(deps.now()).toISOString(),
    operation: "go_live",
    face: input.face,
    gameId,
    revisionId: snapshot.page!.revisionId,
    publicationId: snapshot.build?.publicationId ?? null,
    ...(snapshot.build?.plan ? { clients: selection.clients, remove: selection.remove } : {}),
  };
  await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "started" });
  let hold: Record<string, unknown> | null = null;
  const requested = fresh();
  try {
    // The Build first: a released page needs a playable release (or one on its way).
    while (snapshot.build && snapshot.build.checks.state === "checking" && deps.now() < deadline) {
      await deps.sleep(POLL_MS);
      snapshot = await read(store, gameId, snapshot.build.publicationId, selection);
    }
    if (snapshot.build?.checks.state === "checking") {
      const since = stillCheckingSince(snapshot) ? `${STILL_CHECKING} ` : "";
      return { ok: true, status: "waiting", waitingOn: "automated_checks", ...view(snapshot), next: `${since}Summer's automated checks are still running. Call summer_go_live again with confirm=true to keep going; nothing is asked twice.` };
    }
    const stopped = blockers(snapshot);
    if (stopped.length) return { ok: true, status: "blocked", ...view(snapshot), failures: stopped, next: "Fix each failure, then call summer_go_live again." };
    if (snapshot.build) hold = await releaseBuild(store, gameId, snapshot, deps, deadline, requested);
    if (requested.refused) {
      return { ok: true, status: "blocked", ...view({ ...snapshot, dropped: requested.dropped, notUsed: requested.notUsed }), failures: [serverOnlyFailure(requested.refused.message)], next: `${serverOnlyRefusal(requested.refused.message)} Then call summer_go_live again.` };
    }
    if (requested.clientRefused) {
      return { ok: true, status: "blocked", ...view(snapshot), failures: [clientRefusal(requested.clientRefused)], next: "Nothing was released. Fix the failure, then call summer_go_live again." };
    }
    const refused = await publishPage(store, gameId, snapshot);
    if (refused) return { ...view(snapshot), ...refused };
  } catch (error) {
    if (error instanceof BuildToolError && error.code === "owner_approval_required") return { ...view(snapshot), ...permissionRefused() };
    await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "failed", code: error instanceof BuildToolError ? error.code : "go_live_failed" });
    throw error;
  }
  await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "requested" });

  // Watch until players get it, a check fails or the wait ends.
  for (;;) {
    snapshot = await read(store, gameId, snapshot.build?.publicationId, selection, requested);
    const stillHeld = onHold(snapshot);
    if (stillHeld) return stillHeld;
    const again = sentBack(snapshot);
    if (again) return again;
    if (isLive(snapshot)) {
      await appendStoreJsonLine("creator-audit.jsonl", { ...audit, outcome: "live" });
      const held = snapshot.build ? releasable(snapshot.build).held : [];
      return {
        ok: true,
        status: "live",
        ...viewAfter(snapshot, requested),
        ...(held.length ? { notReleased: held } : {}),
        next: held.length
          ? `Live. ${held.map((check) => check.platform).join(", ")} did not pass its checks and is not released: apply each fix and upload a new version.${droppedLine(snapshot)}`
          : `${liveLine(snapshot)}${requested.removed.length ? ` Taken out as asked: ${requested.removed.map(named).join(", ")}.` : ""}${droppedLine(snapshot)}`,
      };
    }
    const failed = blockers(snapshot);
    if (failed.length) return { ok: true, status: "blocked", ...view(snapshot), failures: failed, next: "Fix each failure, then call summer_go_live again." };
    if (deps.now() >= deadline) break;
    await deps.sleep(POLL_MS);
  }
  // Nothing blocks going live any more. A platform that predates review after
  // live may still hold a first launch, and a Publish's checks may run long:
  // either is Summer's, with nothing for the creator to do.
  const activating = snapshot.review !== null && !hold && !stillCheckingSince(snapshot);
  return {
    ok: true,
    status: "waiting",
    waitingOn: activating ? "activation" : "summer",
    ...view(snapshot),
    ...(activating ? {} : { hold: hold ?? summerHold(snapshot) }),
    next: activating
      ? "The platform is activating it. Call summer_go_live again with confirm=true to keep watching; nothing is asked twice."
      : stillCheckingSince(snapshot)
        ? `${STILL_CHECKING} Call summer_go_live again with confirm=true to keep watching; it reports the moment players get it.`
        : "Nothing to fix. Call summer_go_live again with confirm=true to keep watching; it reports the moment players get it.",
  };
}
