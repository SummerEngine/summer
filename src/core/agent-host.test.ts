import { afterEach, describe, expect, it } from "vitest";
import {
  hostFromClientName,
  hostFromEnv,
  isTelemetryDisabled,
  processSurface,
  registerMcpClientSource,
  resolveAgentHost,
  runWithToolContext,
  summerRequestHeaders,
} from "./agent-host.js";
import { TOOLKIT_VERSION } from "./version.js";

// The server's accepted host id (publicsummerengine src/lib/mcp/agent-host.ts).
const SERVER_HOST_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

afterEach(() => registerMcpClientSource(null));

describe("agent host", () => {
  it("prefers the override, then the MCP handshake, then the environment", () => {
    const client = { name: "claude-code", version: "2.1.0" };
    expect(resolveAgentHost({ SUMMER_AGENT_HOST: "My Wrapper" }, client)).toEqual({ id: "my-wrapper", source: "override" });
    expect(resolveAgentHost({ CODEX_THREAD_ID: "t" }, client)).toEqual({ id: "claude-code", source: "mcp-client" });
    expect(resolveAgentHost({ CODEX_THREAD_ID: "t" }, undefined)).toEqual({ id: "codex", source: "env" });
    expect(resolveAgentHost({}, undefined)).toEqual({ id: "unknown", source: "none" });
  });

  it("maps known client names and keeps unknown ones in the server's id shape", () => {
    expect(hostFromClientName("Visual Studio Code")).toBe("vscode");
    expect(hostFromClientName("codex-mcp-client")).toBe("codex");
    expect(hostFromClientName("cursor-vscode")).toBe("cursor");
    const other = hostFromClientName("Acme Agent/1.0 (beta)")!;
    expect(other).toBe("other.acme-agent-1-0-beta");
    expect(other).toMatch(SERVER_HOST_ID);
  });

  it("reads AI_AGENT before per-host variables, and a Cursor terminal last", () => {
    expect(hostFromEnv({ AI_AGENT: "claude-code_2-1-282_agent", CURSOR_TRACE_ID: "x" })).toBe("claude-code");
    expect(hostFromEnv({ CLAUDECODE: "1", CURSOR_TRACE_ID: "x" })).toBe("claude-code");
    expect(hostFromEnv({ CURSOR_TRACE_ID: "x" })).toBe("cursor");
    expect(hostFromEnv({ CLAUDECODE: "0" })).toBeNull();
  });
});

describe("summerRequestHeaders", () => {
  it("names the client app, its version and the running tool", async () => {
    registerMcpClientSource(() => ({ name: "claude-code", version: "2.1.0" }));
    const headers = await runWithToolContext("summer_generate_image", "mcp", async () => {
      await Promise.resolve();
      return summerRequestHeaders({ tool: "summer_fallback" }, {});
    });
    expect(headers).toEqual({
      "X-Summer-Client": "summer-cli",
      "X-Summer-Client-Version": TOOLKIT_VERSION,
      "X-Summer-Client-Surface": "mcp",
      "X-Summer-Agent-Host": "claude-code",
      "X-Summer-Agent-Host-Source": "mcp-client",
      "X-Summer-Agent-Host-Name": "claude-code",
      "X-Summer-Agent-Host-Version": "2.1.0",
      "X-Summer-MCP-Tool": "summer_generate_image",
    });
  });

  it("uses the given tool outside a tool call, and the environment on the CLI", () => {
    const headers = summerRequestHeaders({ tool: "summer_check_job", surface: "cli" }, { CODEX_CI: "1" });
    expect(headers).toMatchObject({ "X-Summer-Client-Surface": "cli", "X-Summer-Agent-Host": "codex", "X-Summer-Agent-Host-Source": "env", "X-Summer-MCP-Tool": "summer_check_job" });
    expect(headers).not.toHaveProperty("X-Summer-Agent-Host-Name");
  });

  it("keeps header values printable and short", () => {
    registerMcpClientSource(() => ({ name: "Agent™\n" + "x".repeat(200), version: "1.0\r\n" }));
    const headers = summerRequestHeaders({ surface: "mcp" }, {});
    expect(headers["X-Summer-Agent-Host-Name"]).toMatch(/^Agentx+$/);
    expect(headers["X-Summer-Agent-Host-Name"]!.length).toBeLessThanOrEqual(64);
    expect(headers["X-Summer-Agent-Host-Version"]).toBe("1.0");
  });

  it("sends only the product headers under SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1", () => {
    registerMcpClientSource(() => ({ name: "claude-code", version: "2.1.0" }));
    for (const env of [{ SUMMER_NO_TELEMETRY: "1" }, { DO_NOT_TRACK: "1" }]) {
      const headers = runWithToolContext("summer_generate_3d", "mcp", () => summerRequestHeaders({}, env));
      expect(Object.keys(headers).sort()).toEqual(["X-Summer-Client", "X-Summer-Client-Surface", "X-Summer-Client-Version"]);
    }
  });
});

describe("processSurface", () => {
  it("is cli for a command and mcp inside summer mcp, so the hosted server can tell them apart", () => {
    expect(processSurface()).toBe("cli");
    expect(summerRequestHeaders()["X-Summer-Client-Surface"]).toBe("cli");
    registerMcpClientSource(() => undefined);
    expect(processSurface()).toBe("mcp");
  });
});

describe("isTelemetryDisabled", () => {
  it("takes 1, true, yes or on in either variable", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(isTelemetryDisabled({ SUMMER_NO_TELEMETRY: value })).toBe(true);
      expect(isTelemetryDisabled({ DO_NOT_TRACK: value })).toBe(true);
    }
    for (const value of ["0", "false", "", "no"]) expect(isTelemetryDisabled({ DO_NOT_TRACK: value })).toBe(false);
    expect(isTelemetryDisabled({})).toBe(false);
  });
});
