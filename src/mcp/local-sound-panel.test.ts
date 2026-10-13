import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./server.js";
import { LOCAL_SOUND_PANEL_URI, localSoundPanelHtml, withLocalSoundPanel } from "./local-sound-panel.js";

vi.mock("../core/auth.js", () => ({ getAuthToken: vi.fn(async () => "local-gateway-token") }));

const id = "a".repeat(32);
const clip = { clipId: "clip-1", modelId: "sonilo-sfx-1.1", modelName: "Sonilo", audioUrl: "https://fal.media/a.wav", assetId: "asset-1", durationSeconds: 1 };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

async function connected() {
  const { server, getRegisteredToolCount } = createMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "local-sound-host", version: "1.0.0" });
  await client.connect(clientSide);
  return { client, server, getRegisteredToolCount };
}

describe("local sound choice MCP App", () => {
  it("lists locally owned tool metadata and the exact bundled resource through the installed SDK", async () => {
    const { client, server, getRegisteredToolCount } = await connected();
    try {
      expect(getRegisteredToolCount()).toBeGreaterThan(0);
      const tools = (await client.listTools()).tools;
      const generate = tools.find((tool) => tool.name === "summer_generate_sfx_choices")!;
      const get = tools.find((tool) => tool.name === "summer_get_choices")!;
      expect(generate.inputSchema.properties).toHaveProperty("open");
      expect(generate._meta).toMatchObject({ ui: { resourceUri: LOCAL_SOUND_PANEL_URI, visibility: ["model"] } });
      expect(generate._meta?.securitySchemes).toBeUndefined();
      expect(get.inputSchema.properties).toHaveProperty("choiceSetId");
      expect(get._meta).toMatchObject({ ui: { resourceUri: LOCAL_SOUND_PANEL_URI, visibility: ["model", "app"] }, "openai/widgetAccessible": true });
      expect(get.annotations?.readOnlyHint).toBe(true);
      expect(get._meta?.securitySchemes).toBeUndefined();
      expect((await client.listResources()).resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ uri: LOCAL_SOUND_PANEL_URI, mimeType: "text/html;profile=mcp-app" }),
      ]));
      const resource = (await client.readResource({ uri: LOCAL_SOUND_PANEL_URI })).contents[0];
      expect(resource.text).toBe(await localSoundPanelHtml());
      expect(createHash("sha256").update(resource.text ?? "").digest("hex")).toBe("f694b2ee98929d5682c49ca27be846afe06050b449c60d6b0d1d6f9338eafd7c");
      expect(resource.text).toContain('rpc("ui/initialize"');
      expect(resource.text).toContain('"summer_get_choices"');
      expect(resource.text).not.toContain('callTool("summer_generate_sfx_choices"');
      expect(resource._meta).toMatchObject({ ui: { csp: { resourceDomains: expect.arrayContaining(["https://fal.media"]) } } });
    } finally { await client.close(); await server.close(); }
  });

  it("keeps gateway bearer and legacy text while adding a valid structured view to both local tools", async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url: String(url), options });
      if (options.method === "POST") return new Response(JSON.stringify({ ok: true, choiceSetId: id, reviewUrl: `https://www.summerengine.com/studio/choices/${id}`, prompt: "door tap", clips: [clip] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, choiceSetId: id, status: "decided", clips: [{ ...clip, approved: true, note: "Good" }], preferredModelId: clip.modelId }), { status: 200 });
    }) as typeof fetch;
    const { client, server } = await connected();
    try {
      const made = await client.callTool({ name: "summer_generate_sfx_choices", arguments: { text: "door tap", open: false } });
      expect(made.isError).not.toBe(true);
      expect(made.structuredContent).toEqual(JSON.parse((made.content[0] as { text: string }).text));
      expect(made.structuredContent).toMatchObject({ choiceSetId: id, reviewUrl: `https://www.summerengine.com/studio/choices/${id}` });
      const read = await client.callTool({ name: "summer_get_choices", arguments: { choiceSetId: id, waitSeconds: 0 } });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toEqual(JSON.parse((read.content[0] as { text: string }).text));
      expect(read.structuredContent).toMatchObject({ status: "decided", clips: [{ approved: true, note: "Good" }] });
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toContain("/api/mcp/generate/audio/choices");
      expect(calls[1].url).toContain(`/api/mcp/choices/${id}`);
      expect(calls[0].options.headers).toMatchObject({ Authorization: "Bearer local-gateway-token" });
      expect(calls[1].options.headers).toMatchObject({ Authorization: "Bearer local-gateway-token" });
    } finally { await client.close(); await server.close(); }
  });

  it("does not structure refused or malformed results and never changes their text/error", () => {
    const refused = { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: "denied" }) }] };
    expect(withLocalSoundPanel(refused)).toBe(refused);
    for (const value of [null, { ok: false, choiceSetId: id, clips: [clip] }, { ok: true, choiceSetId: id, clips: [null] }, { ok: true, choiceSetId: id, status: "wrong", clips: [clip] }]) {
      const original = { content: [{ type: "text", text: JSON.stringify(value) }] };
      expect(withLocalSoundPanel(original)).toBe(original);
    }
    const invalidJson = { content: [{ type: "text", text: "{" }] };
    expect(withLocalSoundPanel(invalidJson)).toBe(invalidJson);
  });
});
