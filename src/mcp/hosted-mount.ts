import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getStoreAccessToken, OAuthError, resolveMcpResourceUrl } from "../core/oauth.js";
import { appendMcpLogEvent } from "../core/mcp-log.js";
import { TOOLKIT_VERSION } from "../core/version.js";

/**
 * One Summer Engine MCP. The cloud tools a creator's agent needs to publish
 * (projects, store page, build upload, submit for the owner's approval, the
 * board, Grow) live on the hosted Summer Engine MCP at mcp.summerengine.com,
 * the same server ChatGPT and Claude connect to. This module mounts them into
 * the local MCP so a local agent sees one server: each hosted tool, prompt
 * and resource is registered here under its own name and forwarded with the
 * person's store sign-in ("summer login --store"; the token's audience is
 * that server). A name the local MCP already has stays local (the engine and
 * generation tools keep their CLI-token path).
 *
 * Mounting is lazy: the server answers with the engine tools at once, and the
 * hosted tools appear when the mount finishes (tools/list_changed). Without a
 * store sign-in one tool, summer_store_tools, says how to sign in and mounts
 * on the next call.
 */

export const STORE_TOOLS_STATUS = "summer_store_tools";
const CALL_TIMEOUT_MS = 120_000;
const passthroughArgs = z.object({}).passthrough();

/** The part of an MCP client the mount uses (a fake in tests). */
export interface HostedClient {
  listTools(params?: { cursor?: string }): Promise<{ tools: Tool[]; nextCursor?: string }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<Record<string, unknown>>;
  listPrompts(params?: { cursor?: string }): Promise<{ prompts: Array<{ name: string; title?: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>; nextCursor?: string }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<Record<string, unknown>>;
  listResources(params?: { cursor?: string }): Promise<{ resources: Array<{ uri: string; name: string; title?: string; description?: string; mimeType?: string }>; nextCursor?: string }>;
  readResource(params: { uri: string }): Promise<Record<string, unknown>>;
}

export interface HostedMountDependencies {
  /** The hosted Summer Engine MCP URL (the store sign-in's resource). */
  url: () => string;
  token: () => Promise<string>;
  connect: (url: string, token: () => Promise<string>) => Promise<HostedClient>;
}

export const defaultHostedMountDependencies: HostedMountDependencies = {
  url: () => resolveMcpResourceUrl(),
  token: () => getStoreAccessToken(),
  connect: async (url, token) => {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      // A fresh (refreshed when near expiry) token on every request.
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${await token()}`);
        return fetch(input, { ...init, headers });
      },
    });
    const client = new Client({ name: "summer-engine-local", version: TOOLKIT_VERSION });
    await client.connect(transport);
    const timeout = { timeout: CALL_TIMEOUT_MS };
    return {
      listTools: (params) => client.listTools(params),
      callTool: (params) => client.callTool(params, undefined, timeout) as Promise<Record<string, unknown>>,
      listPrompts: (params) => client.listPrompts(params),
      getPrompt: (params) => client.getPrompt(params) as Promise<Record<string, unknown>>,
      listResources: (params) => client.listResources(params),
      readResource: (params) => client.readResource(params) as Promise<Record<string, unknown>>,
    };
  },
};

export interface HostedMountState {
  status: "idle" | "mounting" | "mounted" | "unavailable";
  tools: string[];
  prompts: string[];
  resources: string[];
  /** Hosted names the local MCP already defines (kept local). */
  collisions: string[];
  error?: { code: string; message: string; recovery: string };
}

interface Registries {
  _registeredTools: Record<string, unknown>;
  _registeredPrompts: Record<string, unknown>;
  _registeredResources: Record<string, unknown>;
}

async function listAll<T>(page: (cursor?: string) => Promise<{ nextCursor?: string } & Record<string, unknown>>, key: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 20; pages++) {
    const result = await page(cursor);
    out.push(...((result[key] as T[] | undefined) ?? []));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return out;
}

function errorText(error: { code: string; message: string; recovery: string }) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, ...error }) }], isError: true };
}

/**
 * Get the server ready for hosted tools before the transport connects (the
 * SDK fixes capabilities at connect): resource handlers exist, and tools/list
 * reports each mounted tool's own JSON Schema rather than the passthrough one.
 * Returns mount(), which callers run after connect without awaiting it.
 */
export function prepareHostedMount(server: McpServer, deps: HostedMountDependencies = defaultHostedMountDependencies) {
  const state: HostedMountState = { status: "idle", tools: [], prompts: [], resources: [], collisions: [] };
  const schemas = new Map<string, Tool>();
  const registries = server as unknown as Registries;

  // Declare the resources capability now: registering one and removing it
  // keeps the handlers (and capability) without listing anything yet.
  server.registerResource("summer-hosted-placeholder", "summer://hosted/placeholder", {}, async () => ({ contents: [] })).remove();

  // tools/list as the SDK builds it, with mounted tools carrying their hosted schema.
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{ tools: Tool[] }>> })._requestHandlers;
  const listTools = handlers.get("tools/list");
  if (listTools) {
    server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const result = await listTools(request, extra);
      return {
        ...result,
        tools: result.tools.map((tool) => {
          const hosted = schemas.get(tool.name);
          return hosted ? { ...tool, inputSchema: hosted.inputSchema, ...(hosted.annotations ? { annotations: hosted.annotations } : {}), ...(hosted.title ? { title: hosted.title } : {}) } : tool;
        }),
      };
    });
  }

  let statusTool: { remove(): void } | null = null;
  let running: Promise<HostedMountState> | null = null;

  const showStatusTool = () => {
    if (statusTool || STORE_TOOLS_STATUS in registries._registeredTools) return;
    statusTool = server.registerTool(
      STORE_TOOLS_STATUS,
      {
        description:
          "The Summer store, publishing, board and Grow tools come from the hosted Summer Engine MCP and are not loaded. Call this to see why and how to fix it (usually: run \"summer login --store\" in a terminal); it loads them when the sign-in works.",
        inputSchema: passthroughArgs,
      },
      async () => {
        const after = await mount();
        if (after.status === "mounted") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, loaded: after.tools.length, tools: after.tools }) }] };
        }
        return errorText(after.error ?? { code: "store_tools_unavailable", message: "The hosted tools are not loaded.", recovery: 'Recovery: run "summer login --store", then call this again.' });
      }
    );
  };

  async function attempt(): Promise<HostedMountState> {
    let client: HostedClient;
    try {
      const url = deps.url();
      await deps.token();
      client = await deps.connect(url, deps.token);
    } catch (error) {
      state.status = "unavailable";
      state.error =
        error instanceof OAuthError
          ? { code: error.code, message: error.message.replace(` ${error.recovery}`, ""), recovery: error.recovery }
          : {
              code: "store_tools_unreachable",
              message: `The hosted Summer Engine MCP did not answer: ${error instanceof Error ? error.message : String(error)}.`,
              recovery: 'Recovery: check the network; if it says unauthorized, run "summer login --store --force". Then call summer_store_tools.',
            };
      appendMcpLogEvent("mcp:hosted_mount_failed", { code: state.error.code });
      showStatusTool();
      return state;
    }

    const [tools, prompts, resources] = await Promise.all([
      listAll<Tool>((cursor) => client.listTools(cursor ? { cursor } : undefined) as never, "tools"),
      listAll<Awaited<ReturnType<HostedClient["listPrompts"]>>["prompts"][number]>((cursor) => client.listPrompts(cursor ? { cursor } : undefined) as never, "prompts").catch(() => []),
      listAll<Awaited<ReturnType<HostedClient["listResources"]>>["resources"][number]>((cursor) => client.listResources(cursor ? { cursor } : undefined) as never, "resources").catch(() => []),
    ]);

    for (const tool of tools) {
      if (tool.name in registries._registeredTools && !schemas.has(tool.name)) {
        if (tool.name !== STORE_TOOLS_STATUS) state.collisions.push(tool.name);
        continue;
      }
      if (schemas.has(tool.name)) continue;
      schemas.set(tool.name, tool);
      server.registerTool(
        tool.name,
        { description: tool.description ?? "", inputSchema: passthroughArgs, ...(tool.annotations ? { annotations: tool.annotations } : {}) },
        async (args: Record<string, unknown>) => {
          try {
            return (await client.callTool({ name: tool.name, arguments: args })) as never;
          } catch (error) {
            return errorText({
              code: "store_tool_failed",
              message: `The hosted Summer Engine MCP did not complete ${tool.name}: ${error instanceof Error ? error.message : String(error)}.`,
              recovery: 'Recovery: retry; if it says unauthorized, run "summer login --store --force".',
            });
          }
        }
      );
      state.tools.push(tool.name);
    }

    for (const prompt of prompts) {
      if (prompt.name in registries._registeredPrompts) {
        if (!state.prompts.includes(prompt.name)) state.collisions.push(`prompt:${prompt.name}`);
        continue;
      }
      const shape = Object.fromEntries((prompt.arguments ?? []).map((arg) => [arg.name, arg.required ? z.string().describe(arg.description ?? "") : z.string().optional().describe(arg.description ?? "")]));
      server.registerPrompt(
        prompt.name,
        { ...(prompt.title ? { title: prompt.title } : {}), ...(prompt.description ? { description: prompt.description } : {}), ...(prompt.arguments?.length ? { argsSchema: shape } : {}) },
        (async (args: Record<string, string | undefined> = {}) =>
          client.getPrompt({ name: prompt.name, arguments: Object.fromEntries(Object.entries(args).filter((entry): entry is [string, string] => typeof entry[1] === "string")) })) as never
      );
      state.prompts.push(prompt.name);
    }

    for (const resource of resources) {
      if (resource.uri in registries._registeredResources) {
        if (!state.resources.includes(resource.uri)) state.collisions.push(`resource:${resource.uri}`);
        continue;
      }
      server.registerResource(
        resource.name,
        resource.uri,
        { ...(resource.title ? { title: resource.title } : {}), ...(resource.description ? { description: resource.description } : {}), ...(resource.mimeType ? { mimeType: resource.mimeType } : {}) },
        async (uri) => (await client.readResource({ uri: uri.href })) as never
      );
      state.resources.push(resource.uri);
    }

    statusTool?.remove();
    statusTool = null;
    state.status = "mounted";
    delete state.error;
    appendMcpLogEvent("mcp:hosted_mounted", { tools: state.tools.length, prompts: state.prompts.length, resources: state.resources.length, collisions: state.collisions.length });
    return state;
  }

  /** Mount once; a failed mount runs again on the next call. */
  function mount(): Promise<HostedMountState> {
    if (state.status === "mounted") return Promise.resolve(state);
    if (!running) {
      state.status = "mounting";
      running = attempt()
        .catch((error) => {
          state.status = "unavailable";
          state.error = { code: "store_tools_unreachable", message: error instanceof Error ? error.message : String(error), recovery: "Recovery: call summer_store_tools to retry." };
          showStatusTool();
          return state;
        })
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  return { mount, state };
}
