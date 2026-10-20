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
const NAMES: Record<string, { name: string; device: string; app: string }> = {
  ios: { name: "iOS", device: "iPhone", app: "iPhone app" },
  android: { name: "Android", device: "Android", app: "Android app" },
  macos: { name: "macOS", device: "Mac", app: "Mac app" },
  windows: { name: "Windows", device: "Windows", app: "Windows app" },
  linux: { name: "Linux", device: "Linux", app: "Linux app" },
  web: { name: "Web", device: "the web", app: "web build" },
};

/** A store page that lists only dropped platforms keeps the previous release, refused with playable_release_required. */
export const SERVER_ONLY_REFUSAL = "Upload a build that includes your game's apps so they can be checked against the new server.";

function messageOf(platform: string, reason: string): string {
  const named = NAMES[platform] ?? { name: platform, device: platform, app: `${platform} app` };
  switch (reason) {
    case "client_check_failed":
      return `${named.name} isn't included: this build couldn't be checked for ${named.device}.`;
    case "client_check_pending":
      return `${named.name} isn't included: its check is still running. Publish again to include ${named.name}.`;
    case "client_not_checked":
      return `${named.name} isn't included: this build has no ${named.app}.`;
    case "client_other_build":
      return `${named.name} isn't included: select this build's ${named.app}.`;
    default:
      return `${named.name} isn't included in this version.`;
  }
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
