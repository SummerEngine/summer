import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLibraryIndex } from "../core/library-search.js";
import { legacyNames } from "../core/ops/contract.js";
import { PACKAGE_ROOT } from "../core/package-root.js";
import { setSummerDirForTests } from "../core/store.js";
import { createMcpServer } from "./server.js";
import { resolveToolSelection } from "./tool-surface.js";

/**
 * Each engine tool's guide (library/tools/<slug>/GUIDE.md, read with
 * docs.read tool/<slug>) is its 3.x MCP description: the v4 surface lists a
 * short summary and points at the guide, so the how-to has one source while
 * the 3.x surface still serves the same text.
 *
 * Changed a description? Regenerate the guides, then the registry:
 *   npm run generate:tool-guides && npm run generate:registry
 */

const GUIDE_FILE = "GUIDE.md";

function guideText(toolName: string, description: string): string {
  return `# ${toolName}\n\n${description.trim()}\n`;
}

let root = "";
let descriptions = new Map<string, string>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-tool-guides-"));
  setSummerDirForTests(join(root, ".summer"));
  const { server } = createMcpServer(resolveToolSelection({ profile: "full" }, {}), { surface: "v3" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "tool-guides", version: "1" });
  await client.connect(clientSide);
  descriptions = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool.description ?? ""]));
  await client.close();
  await server.close();
});

afterAll(async () => {
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

describe("engine tool guides (library/tools/<slug>/GUIDE.md)", () => {
  it("hold each engine tool's 3.x description", () => {
    const names = legacyNames();
    const slugs = new Map(loadLibraryIndex().filter((entry) => entry.kind === "tool").map((entry) => [entry.mcp_tool_name, entry.id.replace(/^tool\//, "")]));
    const update = process.env.UPDATE_TOOL_GUIDES === "1";
    const drifted: string[] = [];
    let checked = 0;
    for (const [toolName, description] of descriptions) {
      if (!names[toolName]?.op.startsWith("engine.")) continue;
      const slug = slugs.get(toolName);
      expect(slug, `${toolName} has a library descriptor`).toBeTruthy();
      const file = join(PACKAGE_ROOT, "library", "tools", slug!, GUIDE_FILE);
      const expected = guideText(toolName, description);
      checked += 1;
      if (existsSync(file) && readFileSync(file, "utf8") === expected) continue;
      if (update) writeFileSync(file, expected);
      else drifted.push(`library/tools/${slug}/${GUIDE_FILE}`);
    }
    expect(checked).toBeGreaterThan(70);
    expect(drifted, "Run: npm run generate:tool-guides && npm run generate:registry").toEqual([]);
  });
});
