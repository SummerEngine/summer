import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAuthToken } from "../core/auth.js";
import { _resetTelemetryPingedForTests } from "../core/telemetry.js";
import { setSummerDirForTests } from "../core/store.js";
import { PACKAGE_ROOT } from "../core/package-root.js";
import { createMcpServer } from "./server.js";

let root = "";
const saved = { ...process.env };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-tool-calls-test-"));
  setSummerDirForTests(join(root, ".summer"));
  delete process.env.SUMMER_NO_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  delete process.env.SUMMER_TOKEN;
  process.env.SUMMER_GATEWAY_URL = "https://gateway.example";
  _resetTelemetryPingedForTests();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  setSummerDirForTests(null);
  for (const key of ["SUMMER_NO_TELEMETRY", "DO_NOT_TRACK", "SUMMER_TOKEN", "SUMMER_GATEWAY_URL"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true });
});

async function session() {
  const { server } = createMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "claude-code", version: "2.0.0" });
  await client.connect(clientSide);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]?.text ?? "");

describe("capped results through the MCP server", () => {
  it("cuts a long library read at its default cap, keeps the footer, and gives all of it on request", async () => {
    const { client, close } = await session();
    try {
      const { tools } = await client.listTools();
      expect(tools.find((tool) => tool.name === "summer_read_library")!.inputSchema.properties).toHaveProperty("maxCharacters");
      expect(tools.find((tool) => tool.name === "summer_write_file")!.inputSchema.properties).not.toHaveProperty("maxCharacters");

      // The longest skill body in the library, whichever it is today.
      const skillsDir = join(PACKAGE_ROOT, "library", "skills");
      const longest = readdirSync(skillsDir)
        .filter((slug) => existsSync(join(skillsDir, slug, "SKILL.md")))
        .map((slug) => ({ slug, length: readFileSync(join(skillsDir, slug, "SKILL.md"), "utf8").length }))
        .sort((a, b) => b.length - a.length)[0]!;
      expect(longest.length).toBeGreaterThan(24000);
      const id = `skill/${longest.slug}`;

      const cut = text(await client.callTool({ name: "summer_read_library", arguments: { id, part: "skill" } }));
      expect(cut).toMatch(/\[Truncated: 24000 of \d+ characters shown\. Call again with maxCharacters: \d+/);
      expect(cut).toContain(`— entry_id: ${id}@`);

      const full = text(await client.callTool({ name: "summer_read_library", arguments: { id, part: "skill", maxCharacters: 200000 } }));
      expect(full).not.toContain("[Truncated:");
      expect(full.length).toBeGreaterThan(24000);
    } finally {
      await close();
    }
  });
});

describe("local tool call reports", () => {
  async function callAndCollect(): Promise<Array<{ url: string; body: Record<string, unknown> }>> {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { body?: string }) => {
      posts.push({ url: String(input), body: JSON.parse(init?.body ?? "{}") });
      return new Response("{}", { status: 200 });
    });
    await saveAuthToken("file-token");
    const { client, close } = await session();
    try {
      await client.callTool({ name: "summer_get_agent_playbook", arguments: {} });
    } finally {
      await close();
    }
    // The session line and the call line are fire-and-forget (store reads, then fetch).
    const deadline = Date.now() + 1000;
    while (posts.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return posts;
  }

  it("sends the tool name, its operation, success, duration, the host app name and the surface, nothing else", async () => {
    const posts = await callAndCollect();
    const calls = posts.filter((post) => post.body.event === "mcp_tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gateway.example/api/mcp/log-local-call");
    expect(Object.keys(calls[0].body).sort()).toEqual(["client", "durationMs", "event", "mcpClient", "ok", "op", "profile", "surfaceVersion", "tool"]);
    expect(calls[0].body).toMatchObject({
      client: "summer-cli",
      event: "mcp_tool_call",
      mcpClient: "claude-code",
      tool: "summer_get_agent_playbook",
      op: "docs.read",
      surfaceVersion: "v3",
      profile: "full",
      ok: true,
    });
    expect(typeof calls[0].body.durationMs).toBe("number");
  });

  it("sends one session line on the first tool call, with the host app name and this machine's install id", async () => {
    const posts = await callAndCollect();
    const sessions = posts.filter((post) => post.body.event === "mcp_session_start");
    expect(sessions.map((post) => post.body)).toEqual([
      { client: "summer-cli", event: "mcp_session_start", mcpClient: "claude-code", installId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    ]);
  });

  it("sends nothing with SUMMER_NO_TELEMETRY=1 or DO_NOT_TRACK=1", async () => {
    process.env.SUMMER_NO_TELEMETRY = "1";
    expect(await callAndCollect()).toEqual([]);
    delete process.env.SUMMER_NO_TELEMETRY;
    process.env.DO_NOT_TRACK = "1";
    expect(await callAndCollect()).toEqual([]);
  });
});

describe("requests to Summer's servers", () => {
  it("carry the agent app's name and version from the handshake and the tool that made them", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: { headers?: Record<string, string> }) => {
      requests.push({ url: String(input), headers: { ...(init?.headers ?? {}) } });
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    });
    await saveAuthToken("file-token");
    const { client, close } = await session();
    try {
      await client.callTool({ name: "summer_check_job", arguments: { jobId: "job-1" } });
    } finally {
      await close();
    }
    const job = requests.find((request) => request.url.includes("/api/mcp/jobs/job-1"))!;
    expect(job.headers).toMatchObject({
      "X-Summer-Client": "summer-cli",
      "X-Summer-Client-Surface": "mcp",
      "X-Summer-Agent-Host": "claude-code",
      "X-Summer-Agent-Host-Source": "mcp-client",
      "X-Summer-Agent-Host-Name": "claude-code",
      "X-Summer-Agent-Host-Version": "2.0.0",
      "X-Summer-MCP-Tool": "summer_check_job",
    });
  });
});

