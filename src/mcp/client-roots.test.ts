import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  installClientRootsHandlers,
  resolveClientRootSelection,
} from "./client-roots.js";

const temporaryDirectories: string[] = [];

async function makeProject(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), `summer-mcp-roots-${name}-`));
  temporaryDirectories.push(parent);
  const root = join(parent, name);
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "project.godot"), "[application]\n", "utf8");
  return realpath(root);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  );
});

describe("resolveClientRootSelection", () => {
  it("binds a file root to the containing Summer project", async () => {
    const project = await makeProject("game");
    const result = await resolveClientRootSelection([
      { uri: pathToFileURL(join(project, "nested")).href, name: "Game" },
    ]);

    expect(result.error).toBeUndefined();
    expect(result.selection).toEqual({ projectPath: project, cwd: project });
    expect(result.projectRoots).toEqual([project]);
  });

  it("decodes spaces and accepts a project.godot file root", async () => {
    const project = await makeProject("game with spaces");
    const result = await resolveClientRootSelection([
      { uri: pathToFileURL(join(project, "project.godot")).href },
    ]);

    expect(result.selection).toEqual({ projectPath: project, cwd: project });
  });

  it("deduplicates multiple client roots inside the same project", async () => {
    const project = await makeProject("game");
    const result = await resolveClientRootSelection([
      { uri: pathToFileURL(project).href },
      { uri: pathToFileURL(join(project, "nested")).href },
    ]);

    expect(result.selection?.projectPath).toBe(project);
    expect(result.projectRoots).toEqual([project]);
  });

  it("refuses roots that resolve to different Summer projects", async () => {
    const first = await makeProject("first");
    const second = await makeProject("second");
    const result = await resolveClientRootSelection([
      { uri: pathToFileURL(first).href },
      { uri: pathToFileURL(second).href },
    ]);

    expect(result.selection).toBeUndefined();
    expect(result.error).toContain("more than one Summer project root");
  });

  it("ignores non-file and malformed roots without guessing a project", async () => {
    const result = await resolveClientRootSelection([
      { uri: "https://example.com/project" },
      { uri: "not a URI" },
    ]);

    expect(result.selection).toBeUndefined();
    expect(result.error).toContain("local filesystem root");
  });

  it("reports a local root that is not inside a Summer project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "summer-mcp-roots-empty-"));
    temporaryDirectories.push(directory);
    const result = await resolveClientRootSelection([
      { uri: pathToFileURL(directory).href },
    ]);

    expect(result.selection).toBeUndefined();
    expect(result.error).toContain("No project.godot");
  });
});

describe("installClientRootsHandlers", () => {
  it("does not request roots from a client that did not advertise them", async () => {
    const server = new McpServer({ name: "server", version: "1" });
    const received: string[][] = [];
    const statuses: string[] = [];
    const errors: unknown[] = [];
    installClientRootsHandlers(server, {
      onRefresh: async (loadRoots) => {
        try {
          const roots = await loadRoots();
          received.push(roots.map((root) => root.uri));
        } catch (error) {
          errors.push(error);
        }
      },
      onStatus: (status) => statuses.push(status),
    });
    const client = new Client(
      { name: "client", version: "1" },
      { capabilities: {} }
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await expect.poll(() => statuses).toEqual(["unsupported"]);
    expect(received).toEqual([]);
    expect(errors).toEqual([]);
    await client.close();
    await server.close();
  });

  it("binds initial roots and refreshes when listChanged is advertised", async () => {
    const server = new McpServer({ name: "server", version: "1" });
    const received: string[][] = [];
    installClientRootsHandlers(server, {
      onRefresh: async (loadRoots) => {
        const roots = await loadRoots();
        received.push(roots.map((root) => root.uri));
      },
    });
    const client = new Client(
      { name: "client", version: "1" },
      { capabilities: { roots: { listChanged: true } } }
    );
    let roots = [{ uri: "file:///first" }];
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await expect.poll(() => received.length).toBe(1);
    roots = [{ uri: "file:///second" }];
    await client.sendRootsListChanged();
    await expect.poll(() => received.length).toBe(2);
    expect(received).toEqual([["file:///first"], ["file:///second"]]);
    await client.close();
    await server.close();
  });

  it("ignores list-changed notifications unless the client advertised them", async () => {
    const server = new McpServer({ name: "server", version: "1" });
    const received: string[][] = [];
    installClientRootsHandlers(server, {
      onRefresh: async (loadRoots) => {
        const roots = await loadRoots();
        received.push(roots.map((root) => root.uri));
      },
    });
    const client = new Client(
      { name: "client", version: "1" },
      { capabilities: { roots: {} } }
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: "file:///only" }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await expect.poll(() => received.length).toBe(1);
    await clientTransport.send({
      jsonrpc: "2.0",
      method: "notifications/roots/list_changed",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(1);
    await client.close();
    await server.close();
  });
});
