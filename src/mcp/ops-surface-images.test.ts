import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { FileSaver } from "../core/ops/save-files.js";
import { applyOpsSurface } from "./ops-surface.js";

const image = {
  type: "image" as const,
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=",
};
const images = [image, { ...image, annotations: { audience: ["user" as const], priority: 0.5 } }];
const imageBlocks = (result: unknown) => (result as { content: Array<{ type: string }> }).content.filter((part) => part.type === "image");
const answerOf = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);

/** Real MCP dispatch and serialization, with no editor or network. */
async function session(tool: string, fail = false) {
  const server = new McpServer({ name: "image-regression", version: "1.0.0" });
  const handler = vi.fn(async () => fail
    ? { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, code: "invalid_input", error: "Capture refused." }) }] }
    : { content: [images[0]!, { type: "text" as const, text: JSON.stringify({ width: 1, height: 1 }) }, images[1]!] });
  server.tool(tool, "Capture fixture", { target: z.enum(["scene", "viewport"]).default("viewport") }, handler);
  const cloud = { call: vi.fn(async () => { throw new Error("No cloud call expected"); }) };
  applyOpsSurface(server, { engine: true, legacy: true, cloud, files: new FileSaver({ saveByDefault: false }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "image-test", version: "1.0.0" });
  await client.connect(clientSide);
  return {
    client, handler, cloud,
    close: async () => { await client.close(); await server.close(); },
  };
}

describe("summer_call preserves inline images", () => {
  // apps.screenshot is hosted by its operation name, but the registered 3.x
  // name runs locally: cover that second runLocal dispatch branch too.
  it.each([
    ["summer_screenshot", "engine.screenshot"],
    ["summer_screenshot", "summer_screenshot"],
    ["summer_debug_views", "engine.debug_views"],
    ["summer_app_screenshot", "summer_app_screenshot"],
  ])("%s through %s retains every image block", async (tool, op) => {
    const { client, handler, cloud, close } = await session(tool);
    try {
      const direct = await client.callTool({ name: tool, arguments: { target: "scene" } });
      const facade = await client.callTool({ name: "summer_call", arguments: { op, input: { target: "scene" } } });
      expect(imageBlocks(direct)).toEqual(images);
      expect(imageBlocks(facade)).toEqual(imageBlocks(direct));
      expect(answerOf(facade)).toMatchObject({ ok: true, status: "done", result: { width: 1, height: 1 } });
      expect(facade.isError).toBeFalsy();
      // Do not offer a text-only structured result that hides the images from
      // clients which prefer structuredContent when both forms are present.
      expect(facade.structuredContent).toBeUndefined();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(cloud.call).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("retains structured failures without an image", async () => {
    const { client, close } = await session("summer_screenshot", true);
    try {
      const result = await client.callTool({ name: "summer_call", arguments: { op: "engine.screenshot" } });
      expect(result.isError).toBe(true);
      expect(answerOf(result)).toMatchObject({ ok: false, error: { code: "invalid_input", message: "Capture refused." } });
      expect(imageBlocks(result)).toEqual([]);
      expect(result.structuredContent).toEqual(answerOf(result));
    } finally {
      await close();
    }
  });

  it("validates and dry-runs without invoking the image handler", async () => {
    const { client, handler, close } = await session("summer_screenshot");
    try {
      const invalid = await client.callTool({ name: "summer_call", arguments: { op: "engine.screenshot", input: { target: "invalid" } } });
      expect(answerOf(invalid)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toEqual(answerOf(invalid));
      const dry = await client.callTool({ name: "summer_call", arguments: { op: "engine.screenshot", dryRun: true } });
      expect(answerOf(dry)).toMatchObject({ ok: true, status: "dry_run" });
      expect(dry.structuredContent).toEqual(answerOf(dry));
      expect(imageBlocks(invalid)).toEqual([]);
      expect(imageBlocks(dry)).toEqual([]);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
