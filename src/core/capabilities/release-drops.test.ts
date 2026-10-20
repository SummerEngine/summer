import { describe, expect, it } from "vitest";
import { droppedPlatforms } from "./release-drops.js";

const drop = (target: string, reason: string, extra: Record<string, unknown> = {}) => ({ target, buildId: "build-1", qualificationId: "q-1", reason, ...extra });

describe("droppedPlatforms", () => {
  it.each([
    ["client_check_failed", "iOS isn't included: this build couldn't be checked for iPhone."],
    ["client_check_pending", "iOS isn't included: its check is still running. Publish again to include iOS."],
    ["client_not_checked", "iOS isn't included: this build has no iPhone app."],
    ["client_other_build", "iOS isn't included: select this build's iPhone app."],
    // A reason a newer platform adds still names the platform.
    ["client_newer_than_server", "iOS isn't included in this version."],
  ])("says why a platform was left out (%s)", (reason, message) => {
    expect(droppedPlatforms([drop("ios", reason)])).toEqual([{ platform: "ios", reason, message }]);
  });

  it("names each platform for players and keeps the check's error code", () => {
    expect(droppedPlatforms([drop("macos", "client_not_checked"), drop("android", "client_check_failed", { checkErrorCode: "android_abi_missing" })])).toEqual([
      { platform: "macos", reason: "client_not_checked", message: "macOS isn't included: this build has no Mac app." },
      { platform: "android", reason: "client_check_failed", checkErrorCode: "android_abi_missing", message: "Android isn't included: this build couldn't be checked for Android." },
    ]);
  });

  it("reads a platform without the field, or a malformed one, as nothing left out", () => {
    for (const value of [undefined, null, {}, "ios", [null, { reason: "client_not_checked" }]]) expect(droppedPlatforms(value)).toEqual([]);
  });
});
