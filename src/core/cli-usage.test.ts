import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetCliUsageForTests, cliCommandName, cliUsageBody, noteCliError, sendCliUsage, startCliCommand } from "./cli-usage.js";
import { TOOLKIT_VERSION } from "./version.js";

const saved = { ...process.env };
afterEach(() => {
  _resetCliUsageForTests();
  for (const key of ["SUMMER_NO_TELEMETRY", "DO_NOT_TRACK", "SUMMER_AGENT_HOST", "CLAUDECODE"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** Run one command's line through a fake spawn; returns the body the child would send, or null. */
function sent(exitCode: number, signedIn = true): Record<string, unknown> | null {
  const spawn = vi.fn(() => ({ unref: () => undefined }));
  sendCliUsage(exitCode, { spawn: spawn as never, signedIn: () => signedIn });
  if (spawn.mock.calls.length === 0) return null;
  const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
  expect(command).toBe(process.execPath);
  expect(args[0]).toMatch(/cli-usage-beacon\.js$/);
  expect(options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
  return JSON.parse(args[1]);
}

describe("CLI usage line", () => {
  it("names the command path, words joined by _", () => {
    expect(cliCommandName(["skills", "install"])).toBe("skills_install");
    expect(cliCommandName(["ops", "describe"])).toBe("ops_describe");
    expect(cliCommandName(["create"])).toBe("create");
  });

  it("sends the command, the operation, success, duration, version and agent app, nothing else", () => {
    process.env.SUMMER_AGENT_HOST = "claude-code";
    startCliCommand("engine", "engine.play", Date.now() - 250);
    const body = sent(0)!;
    expect(body).toMatchObject({
      client: "summer-cli",
      event: "cli_command",
      command: "engine",
      op: "engine.play",
      ok: true,
      version: TOOLKIT_VERSION,
      agentHost: "claude-code",
    });
    expect(body.durationMs).toBeGreaterThanOrEqual(250);
    expect(Object.keys(body).sort()).toEqual(["agentHost", "client", "command", "durationMs", "event", "ok", "op", "version"]);
  });

  it("reports the operation's error code, or the exit code", () => {
    startCliCommand("store", "store.publish");
    noteCliError("not_signed_in");
    expect(sent(1)).toMatchObject({ ok: false, error: "not_signed_in" });
    startCliCommand("create");
    expect(sent(1)).toMatchObject({ command: "create", ok: false, error: "exit_1" });
  });

  it("drops an operation name that is not one", () => {
    startCliCommand("engine", "engine.play --scene res://secret.tscn");
    expect(sent(0)).not.toHaveProperty("op");
  });

  it("sends nothing when signed out, when telemetry is off, or for a name that is not a command", () => {
    startCliCommand("doctor");
    expect(sent(0, false)).toBeNull();
    for (const off of ["SUMMER_NO_TELEMETRY", "DO_NOT_TRACK"]) {
      process.env[off] = "1";
      startCliCommand("doctor");
      expect(sent(0)).toBeNull();
      delete process.env[off];
    }
    startCliCommand("rm -rf /");
    expect(sent(0)).toBeNull();
  });

  it("builds the body from the command alone: no arguments can reach it", () => {
    const body = cliUsageBody({ command: "tool", startedAt: 0 }, 0, 10, {});
    expect(body).toEqual({ client: "summer-cli", event: "cli_command", command: "tool", ok: true, durationMs: 10, version: TOOLKIT_VERSION });
  });
});
