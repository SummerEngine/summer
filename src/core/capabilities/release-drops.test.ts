import { describe, expect, it } from "vitest";
import { droppedPlatforms, notUsedPlatforms, serverOnlyRefusal } from "./release-drops.js";

const drop = (target: string, reason: string, extra: Record<string, unknown> = {}) => ({ target, buildId: "build-1", qualificationId: "q-1", reason, ...extra });

describe("droppedPlatforms", () => {
  it.each([
    ["client_check_failed", "iOS isn't included: this build couldn't be checked for iPhone."],
    ["client_check_pending", "iOS isn't included: this build's iPhone check is still running. Publish again when it finishes to include iOS."],
    ["client_not_checked", "iOS isn't included: this build has no iPhone client."],
    ["client_other_build", "iOS isn't included: select this build's iPhone client."],
    ["client_newer_than_server", "iOS isn't included: it was built for a newer server than the live one. Publish the server too."],
    // A reason a newer platform adds still names the platform.
    ["a_reason_added_later", "iOS isn't included in this version."],
  ])("says why a platform was left out (%s)", (reason, message) => {
    expect(droppedPlatforms([drop("ios", reason)])).toEqual([{ platform: "ios", reason, message }]);
  });

  it("names each platform for players and keeps the check's error code", () => {
    expect(droppedPlatforms([drop("macos", "client_not_checked"), drop("android", "client_check_failed", { checkErrorCode: "android_abi_missing" })])).toEqual([
      { platform: "macos", reason: "client_not_checked", message: "macOS isn't included: this build has no Mac client." },
      { platform: "android", reason: "client_check_failed", checkErrorCode: "android_abi_missing", message: "Android isn't included: this build couldn't be checked for Android." },
    ]);
  });

  it("prefers the platform's message for a release with no playable platform left, else asks for a build with the apps", () => {
    expect(serverOnlyRefusal("These apps were built for a newer server than the live one. Publish the server too.")).toBe("These apps were built for a newer server than the live one. Publish the server too.");
    for (const message of [undefined, null, "", "playable_release_required"]) expect(serverOnlyRefusal(message)).toBe("Upload a build that includes your game's apps so they can be checked against the new server.");
  });

  it("reads a platform without the field, or a malformed one, as nothing left out", () => {
    for (const value of [undefined, null, {}, "ios", [null, { reason: "client_not_checked" }]]) expect(droppedPlatforms(value)).toEqual([]);
  });
});

describe("notUsedPlatforms", () => {
  it("passes on the platform's message for a newer client the release did not use", () => {
    const message = "Your newer Windows build wasn't used because it's built for a newer server. Publish the server too.";
    expect(notUsedPlatforms([{ target: "windows", buildId: "b", qualificationId: "q", reason: "client_newer_than_server", message }])).toEqual([{ platform: "windows", reason: "client_newer_than_server", message }]);
  });

  it("names the platform when the platform sends no message", () => {
    expect(notUsedPlatforms([{ target: "ios", reason: "a_reason_added_later" }])).toEqual([{ platform: "ios", reason: "a_reason_added_later", message: "Your newer iOS build wasn't used in this version; players keep the current one." }]);
  });

  it("reads a platform without the field, or a malformed one, as nothing unused", () => {
    for (const value of [undefined, null, {}, "ios", [null, { message: "x" }]]) expect(notUsedPlatforms(value)).toEqual([]);
  });
});
