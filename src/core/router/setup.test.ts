import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRouterAgents, setup } from "./setup.js";

const home = () => homedir();
const claudeConfig = () => join(home(), ".claude.json");

afterEach(() => {
  for (const path of [claudeConfig(), join(home(), ".claude"), join(home(), ".codex"), join(home(), ".agents")]) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("summer router setup", () => {
  it("detects Claude Code and Codex from the agent environment and their home folders", () => {
    expect(detectRouterAgents({}, home())).toEqual([]);
    expect(detectRouterAgents({ CLAUDECODE: "1" }, home())).toEqual(["claude-code"]);
    mkdirSync(join(home(), ".codex"));
    expect(detectRouterAgents({}, home())).toEqual(["codex"]);
  });

  it("plans without --yes, applies with it, and is idempotent", async () => {
    const plan = await setup({ agent: "claude-code", env: {} });
    expect(plan.exitCode).toBe(0);
    expect(plan.result).toMatchObject({
      applied: false,
      agents: [{ agent: "claude-code", mcp: { status: "configure" }, skills: [{ name: "summer-router", status: "install" }, { name: "voice-and-mic-permissions", status: "install" }] }],
    });
    expect(existsSync(claudeConfig())).toBe(false);
    expect((plan.result.next_steps as string[])[0]).toBe("summer router setup --yes");

    const applied = await setup({ agent: "claude-code", yes: true, env: {} });
    expect(applied.result).toMatchObject({
      applied: true,
      restart_agent: true,
      agents: [{ mcp: { status: "configured" }, skills: [{ status: "installed" }, { status: "installed" }] }],
    });
    expect(JSON.parse(readFileSync(claudeConfig(), "utf8")).mcpServers["summer-engine"]).toBeTruthy();
    expect(existsSync(join(home(), ".claude", "skills", "summer-router", "SKILL.md"))).toBe(true);

    const again = await setup({ agent: "claude-code", yes: true, env: {} });
    expect(again.result).toMatchObject({
      restart_agent: false,
      agents: [{ mcp: { status: "already_configured" }, skills: [{ status: "already_installed" }, { status: "already_installed" }] }],
    });
  });

  it("keeps an existing summer-engine entry (a local or channel build) and refuses unknown agents", async () => {
    writeFileSync(claudeConfig(), JSON.stringify({ mcpServers: { "summer-engine": { command: "node", args: ["/dev/summer/dist/bin/summer.js", "mcp"] } } }));
    const kept = await setup({ agent: "claude", yes: true, env: {} });
    expect(kept.result).toMatchObject({ agents: [{ mcp: { status: "kept_existing" } }] });
    expect(JSON.parse(readFileSync(claudeConfig(), "utf8")).mcpServers["summer-engine"].command).toBe("node");

    expect((await setup({ agent: "cursor", env: {} })).exitCode).toBe(2);
    rmSync(claudeConfig());
    rmSync(join(home(), ".claude"), { recursive: true, force: true });
    expect((await setup({ env: {} })).result.error).toMatchObject({ code: "no_agent_detected" });
  });
});
