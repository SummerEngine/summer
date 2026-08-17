import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  snapshotPublicPath,
  stablePublicPathInventory,
} from "./public-surface-paths.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("cross-platform public-surface paths", () => {
  const posixRoots = {
    packageRoot: "/repo/tools/summer-cli",
    engineRoot: "/repo",
  };
  const windowsRoots = {
    packageRoot: "C:\\repo\\tools\\summer-cli",
    engineRoot: "C:\\repo",
  };

  it("snapshots the shipped Windows command hook with POSIX separators", () => {
    expect(
      snapshotPublicPath(
        win32,
        windowsRoots,
        "C:\\repo\\tools\\summer-cli\\hooks\\run-hook.cmd"
      )
    ).toBe("cli/hooks/run-hook.cmd");
  });

  it("sorts and hashes equivalent Windows and POSIX inventories identically", () => {
    const posixInventory = stablePublicPathInventory(posix, posixRoots, [
      "/repo/README.md",
      "/repo/tools/summer-cli/hooks/run-hook.cmd",
      "/repo/tools/summer-cli/README.md",
    ]);
    const windowsInventory = stablePublicPathInventory(win32, windowsRoots, [
      "C:\\repo\\tools\\summer-cli\\README.md",
      "C:\\repo\\README.md",
      "C:\\repo\\tools\\summer-cli\\hooks\\run-hook.cmd",
    ]);

    expect(windowsInventory).toBe(posixInventory);
    expect(windowsInventory).toBe(
      "cli/README.md\ncli/hooks/run-hook.cmd\nengine/README.md"
    );
    expect(sha256(windowsInventory)).toBe(sha256(posixInventory));
  });

  it("rejects absolute or parent-relative escapes from both roots", () => {
    expect(() =>
      snapshotPublicPath(win32, windowsRoots, "D:\\outside\\hook.cmd")
    ).toThrow(/escapes both inventory roots/);
    expect(() =>
      snapshotPublicPath(posix, posixRoots, "/outside/hook.cmd")
    ).toThrow(/escapes both inventory roots/);
  });
});
