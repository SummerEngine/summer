import { describe, expect, it } from "vitest";
import { isLiveProcessFile } from "./real-summer-dir-guard.js";

const HEARTBEAT = "c3e4170a857c336aad9c58adfe75ae02.json";
const WINDOWS = "\\";
const POSIX = "/";

describe("real-summer-dir-guard: classifying files a live engine rewrites", () => {
  it("treats an engine heartbeat as live under the separator the platform's relative() uses", () => {
    expect(isLiveProcessFile(`instances/${HEARTBEAT}`, POSIX)).toBe(true);
    expect(isLiveProcessFile(`instances\\${HEARTBEAT}`, WINDOWS)).toBe(true);
  });

  it("matches this platform's own relative() output by default", () => {
    const separator = process.platform === "win32" ? WINDOWS : POSIX;
    expect(isLiveProcessFile(["instances", HEARTBEAT].join(separator))).toBe(true);
  });

  it("treats the named live-process files as live", () => {
    for (const name of ["mcp.log", "user.json", "auth-token", "credential-metadata.json", "api-token", "api-port"]) {
      expect(isLiveProcessFile(name, POSIX), name).toBe(true);
      expect(isLiveProcessFile(name, WINDOWS), name).toBe(true);
    }
  });

  it("keeps a backslash an ordinary filename character on POSIX, so it is still reported", () => {
    expect(isLiveProcessFile(`instances\\${HEARTBEAT}`, POSIX)).toBe(false);
    expect(isLiveProcessFile("instances\\x.json", POSIX)).toBe(false);
    expect(isLiveProcessFile("instances/x\\y.json", POSIX)).toBe(true);
  });

  it("still reports anything else, so a test that reaches the real ~/.summer fails the run", () => {
    const reported: Array<[path: string, separator: string]> = [
      ["instances/nested/other.json", POSIX],
      ["instances\\nested\\other.json", WINDOWS],
      ["instances/notes.txt", POSIX],
      ["instances\\notes.txt", WINDOWS],
      ["other/instances/x.json", POSIX],
      ["other\\instances\\x.json", WINDOWS],
      ["memory/decision.md", POSIX],
      ["config.json", WINDOWS],
    ];
    for (const [path, separator] of reported) {
      expect(isLiveProcessFile(path, separator), `${path} (${JSON.stringify(separator)})`).toBe(false);
    }
  });
});
