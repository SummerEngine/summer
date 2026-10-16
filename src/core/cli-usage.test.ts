import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetCliUsageForTests,
  cliCommandName,
  cliUsageBody,
  noteCliError,
  noteCliHosted,
  noteCliTool,
  sendCliUsage,
  startCliCommand,
} from "./cli-usage.js";
import { setSummerDirForTests } from "./store.js";

const saved = { ...process.env };
afterEach(() => {
  _resetCliUsageForTests();
  for (const key of ["SUMMER_NO_TELEMETRY", "DO_NOT_TRACK", "SUMMER_AGENT_HOST", "SUMMER_TOKEN"]) {
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

  it("reports an operation as summer_call in the MCP tool-call schema, surface cli, and nothing else", () => {
    process.env.SUMMER_AGENT_HOST = "claude-code";
    startCliCommand("engine", "engine.play", Date.now() - 250);
    const body = sent(0)!;
    expect(body).toMatchObject({
      client: "summer-cli",
      event: "mcp_tool_call",
      surface: "cli",
      tool: "summer_call",
      op: "engine.play",
      ok: true,
      mcpClient: "claude-code",
      surfaceVersion: "v4",
    });
    expect(body.durationMs).toBeGreaterThanOrEqual(250);
    expect(Object.keys(body).sort()).toEqual(["client", "durationMs", "event", "mcpClient", "ok", "op", "surface", "surfaceVersion", "tool"]);
  });

  it("reports any other command under its own name, and a local summer tool under the tool's name", () => {
    startCliCommand("skills_install");
    expect(sent(0)).toMatchObject({ tool: "skills_install", ok: true });
    startCliCommand("tool");
    noteCliTool("summer_play");
    expect(sent(0)).toMatchObject({ tool: "summer_play" });
  });

  it("reports the operation's error code, or the exit code", () => {
    startCliCommand("engine", "engine.play");
    noteCliError("engine_not_running");
    expect(sent(1)).toMatchObject({ ok: false, error: "engine_not_running" });
    startCliCommand("create");
    expect(sent(1)).toMatchObject({ tool: "create", ok: false, error: "exit_1" });
  });

  it("sends nothing for a command Summer's server ran (it records those itself)", () => {
    startCliCommand("store", "store.publish");
    noteCliHosted();
    expect(sent(0)).toBeNull();
  });

  it("drops an operation name that is not one", () => {
    startCliCommand("engine", "engine.play --scene res://secret.tscn");
    const body = sent(0);
    expect(body).toMatchObject({ tool: "engine" });
    expect(body).not.toHaveProperty("op");
  });

  it("keeps only lowercase snake_case error codes", () => {
    startCliCommand("engine", "engine.play");
    noteCliError("player.gd");
    expect(sent(1)).toMatchObject({ error: "exit_1" });
  });

  it("counts SUMMER_TOKEN or a stored account token as signed in, and nothing else", () => {
    const home = mkdtempSync(join(tmpdir(), "summer-cli-usage-"));
    setSummerDirForTests(join(home, ".summer"));
    const spawn = vi.fn(() => ({ unref: () => undefined }));
    try {
      delete process.env.SUMMER_TOKEN;
      startCliCommand("doctor");
      sendCliUsage(0, { spawn: spawn as never });
      expect(spawn).not.toHaveBeenCalled();
      mkdirSync(join(home, ".summer"), { recursive: true });
      writeFileSync(join(home, ".summer", "auth-token"), "token");
      startCliCommand("doctor");
      sendCliUsage(0, { spawn: spawn as never });
      expect(spawn).toHaveBeenCalledTimes(1);
      rmSync(join(home, ".summer", "auth-token"));
      process.env.SUMMER_TOKEN = "env-token";
      startCliCommand("doctor");
      sendCliUsage(0, { spawn: spawn as never });
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      setSummerDirForTests(null);
      rmSync(home, { recursive: true, force: true });
    }
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
    const body = cliUsageBody({ tool: "tool", startedAt: 0 }, 0, 10, {});
    expect(body).toEqual({ client: "summer-cli", event: "mcp_tool_call", surface: "cli", tool: "tool", ok: true, durationMs: 10, mcpClient: "unknown", surfaceVersion: "v4" });
  });
});
