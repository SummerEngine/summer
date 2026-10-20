/**
 * Summer's automated checks on an uploaded game, read the way an agent can act
 * on them: one entry per check with its state, the platform's code and a fix.
 *
 * The codes and their meaning come from the Summer platform's management API
 * (api/management/openapi.yaml, build-publications and client packages) and
 * its pipeline docs (docs/build-publications.md, docs/client-pack-publication.md).
 * Two kinds of failure are kept apart, because only one is the creator's to fix:
 * - creator: the export or its content (a fix is named);
 * - summer: a problem on Summer's side (nothing to change; it retries or
 *   Summer resolves it).
 */

export type CheckOwner = "creator" | "summer";

export interface CheckFix {
  owner: CheckOwner;
  fix: string;
}

/** Why an upload or one of its checks failed, and what to do about it. */
export const CHECK_FIXES: Record<string, CheckFix> = {
  // Intake (build-publications errorCode).
  bundle_invalid: { owner: "creator", fix: "Export again with summer_export_game (the summer.games preset) and upload the .zip exactly as Summer Engine wrote it." },
  declaration_mismatch: { owner: "creator", fix: "Export again with summer_export_game alignDeclaration:true, or with targets equal to what summer.build.json declares." },
  client_version_conflict: { owner: "creator", fix: "This version number already names different bytes: upload with a new clientVersion." },
  artifact_exists: { owner: "creator", fix: "These exact bytes are already a build of this game: use that build (store.status lists it) or export a new version." },
  engine_build_unreleased: {
    owner: "creator",
    fix: "The export came from a Summer Engine build Summer never released (a development or nightly build). Install the released Summer Engine, export again and upload.",
  },
  attempts_exhausted: { owner: "creator", fix: "Summer could not read the upload in five tries, usually because it is very large. Make the export smaller (remove unused assets), export again and upload with a new clientVersion." },
  approval_denied: { owner: "creator", fix: "Summer took this game down, so it can't take new builds. Read Summer's message with store.status, and contact Summer support to have it restored." },
  malware_detected: { owner: "creator", fix: "The malware scan found a threat in the upload. Check the project's files, plugins and add-ons, export again on a clean machine and upload with a new clientVersion." },
  malware_scan_unsupported: { owner: "creator", fix: "The malware scanner could not read this file. Upload the .zip exactly as summer_export_game wrote it (no re-zipping, no password)." },
  materializing_failed: { owner: "creator", fix: "Summer could not unpack the game's server. Read errorMessage, fix the server export, export again and upload with a new clientVersion." },
  building_failed: { owner: "creator", fix: "The game's server image did not build. Read errorMessage, fix it, export again and upload with a new clientVersion." },
  verifying_failed: {
    owner: "creator",
    fix: "The secrets scan found a key or password in the server. Remove it from the project (scripts, .env and config files, the export's include filters), revoke it where it was issued, export again and upload with a new clientVersion.",
  },
  // Client pack and per-platform checks (client packages).
  package_not_verified: {
    owner: "creator",
    fix: "The client pack failed inspection: its main scene must open, and it must carry the export stamp Summer Engine writes. Read errorMessage, fix the project, export again and upload with a new clientVersion.",
  },
  client_platform_unavailable: {
    owner: "creator",
    fix: "Summer cannot run this kind of game on this platform yet (for example web for a game with a server). Export without that platform; ship web as a download (summer_export_game format download).",
  },
  qualification_revoked: { owner: "creator", fix: "Summer withdrew this platform's check result. Export a new version and upload it." },
  // Summer's side: nothing for the creator to change.
  template_set_unavailable: { owner: "summer", fix: "Summer Games is still turning this Summer version on. Nothing to change: retry the same upload later." },
  capacity_limit_reached: { owner: "summer", fix: "Summer Games is busy. Retry the same upload in a few minutes." },
  verification_unavailable: { owner: "summer", fix: "Summer could not run this platform's check right now and retries it. Nothing to change." },
  verification_blocked: { owner: "summer", fix: "Summer held this platform's check for its team. Nothing to change in the game; it continues once Summer resolves it." },
};

export interface PlatformCheck {
  platform: string;
  state: "checking" | "passed" | "failed";
  code?: string;
  message?: string;
  owner?: CheckOwner;
  fix?: string;
}

/** A failure line with its owner and fix (unknown codes are the creator's, with the platform's message). */
export function describeFailure(code: string | null | undefined, message: string | null | undefined): { code: string; message?: string; owner: CheckOwner; fix: string } {
  const known = code ? CHECK_FIXES[code] : undefined;
  return {
    code: code || "check_failed",
    ...(message ? { message: message.length > 400 ? `${message.slice(0, 400)}...` : message } : {}),
    owner: known?.owner ?? "creator",
    fix: known?.fix ?? "Read message, fix what it names in the project, export again and upload with a new clientVersion.",
  };
}

interface Verification {
  platform?: unknown;
  state?: unknown;
  qualificationId?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** Each platform the client pack is checked on, from a build publication's clientPackage. */
export function platformChecks(clientPackage: Record<string, unknown> | null | undefined): PlatformCheck[] {
  const verifications = Array.isArray(clientPackage?.verifications) ? (clientPackage!.verifications as Verification[]) : [];
  return verifications.map((check) => {
    const platform = text(check.platform) ?? "unknown";
    if (check.state === "ready" && text(check.qualificationId)) return { platform, state: "passed" as const };
    if (check.state === "failed") return { platform, state: "failed" as const, ...describeFailure(text(check.errorCode), text(check.errorMessage)) };
    return { platform, state: "checking" as const };
  });
}

export interface ChecksSummary {
  /** passed: every platform passed; failed: the pack or a platform failed; checking: not done yet. */
  state: "checking" | "passed" | "failed";
  checks: PlatformCheck[];
  /** The pack itself was refused (state rejected), before any platform ran. */
  packFailure?: ReturnType<typeof describeFailure>;
}

/** Where the automated checks of one build publication stand. */
export function summarizeChecks(publication: Record<string, any>): ChecksSummary {
  const pack = publication.clientPackage && typeof publication.clientPackage === "object" ? (publication.clientPackage as Record<string, unknown>) : null;
  if (pack?.state === "rejected") {
    return { state: "failed", checks: platformChecks(pack), packFailure: describeFailure("package_not_verified", text(pack.verificationError)) };
  }
  const checks = platformChecks(pack);
  // Wait for every platform: a failure on one does not stop the others from passing.
  if (!pack || pack.state !== "uploaded" || checks.length === 0 || checks.some((check) => check.state === "checking")) {
    return { state: "checking", checks };
  }
  return { state: checks.some((check) => check.state === "failed") ? "failed" : "passed", checks };
}
