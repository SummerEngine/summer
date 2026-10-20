/**
 * Client platforms a release left out (summer-platform DroppedReleaseTarget,
 * SUM-1107). A hosted release joins every client to its one server Build, so a
 * client not qualified against that Build is dropped and the rest of the
 * release goes ahead. The publish answer and the release read both carry the
 * list as droppedTargets; a platform from before it sends none.
 */

export interface DroppedPlatform {
  platform: string;
  reason: string;
  checkErrorCode?: string;
  /** What to tell the creator, in the platform's player-facing name. */
  message: string;
}

/** The platform's name, and what its app is called for players. */
const NAMES: Record<string, { name: string; device: string }> = {
  ios: { name: "iOS", device: "iPhone" },
  android: { name: "Android", device: "Android" },
  macos: { name: "macOS", device: "Mac" },
  windows: { name: "Windows", device: "Windows" },
  linux: { name: "Linux", device: "Linux" },
  web: { name: "Web", device: "web" },
};

/** A store page that lists only dropped platforms keeps the previous release, refused with playable_release_required. */
export const SERVER_ONLY_REFUSAL = "Upload a build that includes your game's apps so they can be checked against the new server.";

/**
 * What to tell the creator about a playable_release_required refusal: the
 * platform's own message (it names the newer-server case), else the upload text.
 */
export function serverOnlyRefusal(message: unknown): string {
  const said = typeof message === "string" ? message.trim() : "";
  return said && said !== "playable_release_required" ? said : SERVER_ONLY_REFUSAL;
}

function messageOf(platform: string, reason: string): string {
  const named = NAMES[platform] ?? { name: platform, device: platform };
  switch (reason) {
    case "client_check_failed":
      return `${named.name} isn't included: this build couldn't be checked for ${named.device}.`;
    case "client_check_pending":
      return `${named.name} isn't included: this build's ${named.device} check is still running. Publish again when it finishes to include ${named.name}.`;
    case "client_not_checked":
      return `${named.name} isn't included: this build has no ${named.device} client.`;
    case "client_other_build":
      return `${named.name} isn't included: select this build's ${named.device} client.`;
    case "client_newer_than_server":
      return `${named.name} isn't included: it was built for a newer server than the live one. Publish the server too.`;
    default:
      return `${named.name} isn't included in this version.`;
  }
}

/**
 * A newer client the release did not use (summer-platform notUsedTargets,
 * SUM-1107): a client-only publish kept the live client of the server's Build,
 * so the platform stays live with its current client. The platform's message
 * says why; a reason without one gets a line naming the platform.
 */
export interface NotUsedPlatform {
  platform: string;
  reason: string;
  message: string;
}

/** The unused newer clients of a publish answer or release read; anything but a list reads as none. */
export function notUsedPlatforms(value: unknown): NotUsedPlatform[] {
  if (!Array.isArray(value)) return [];
  const out: NotUsedPlatform[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.target !== "string" || !item.target) continue;
    const said = typeof item.message === "string" ? item.message.trim() : "";
    const name = NAMES[item.target]?.name ?? item.target;
    out.push({ platform: item.target, reason: typeof item.reason === "string" ? item.reason : "", message: said || `Your newer ${name} build wasn't used in this version; players keep the current one.` });
  }
  return out;
}

/** The dropped platforms of a publish answer or release read; anything but a list reads as none. */
export function droppedPlatforms(value: unknown): DroppedPlatform[] {
  if (!Array.isArray(value)) return [];
  const out: DroppedPlatform[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.target !== "string" || !item.target) continue;
    const reason = typeof item.reason === "string" ? item.reason : "";
    out.push({
      platform: item.target,
      reason,
      ...(typeof item.checkErrorCode === "string" && item.checkErrorCode ? { checkErrorCode: item.checkErrorCode } : {}),
      message: messageOf(item.target, reason),
    });
  }
  return out;
}
