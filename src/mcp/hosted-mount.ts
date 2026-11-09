import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { connectHostedMcp, hostedConnectFailure, HostedUnreachableError, withV3Surface, type HostedClient, type HostedConnectDependencies } from "../core/hosted-mcp.js";
import { getStoreAccessToken, OAuthError, resolveMcpResourceUrl } from "../core/oauth.js";
import { appendMcpLogEvent } from "../core/mcp-log.js";
import { providerSafeSchema } from "./provider-safe-schema.js";

export type { HostedClient };

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
 * Mounting runs after connect. The first tools/list waits for a mount in
 * progress (up to FIRST_LIST_WAIT_MS), so a host that lists tools once still
 * sees the store tools; a slower mount adds them later (tools/list_changed).
 * Without a store sign-in the mount fails at once, and one tool,
 * summer_store_tools, says how to sign in and mounts on the next call.
 */

export const STORE_TOOLS_STATUS = "summer_store_tools";
/** How long the first tools/list waits for a mount in progress, so hosts that list once see the store tools. */
export const FIRST_LIST_WAIT_MS = 5_000;
const passthroughArgs = z.object({}).passthrough();

export type HostedMountDependencies = HostedConnectDependencies;

export const defaultHostedMountDependencies: HostedMountDependencies = {
  url: () => withV3Surface(resolveMcpResourceUrl()),
  token: () => getStoreAccessToken(),
  connect: connectHostedMcp,
};

export interface HostedMountState {
  status: "idle" | "mounting" | "mounted" | "unavailable";
  tools: string[];
  prompts: string[];
  resources: string[];
  /** Hosted names the local MCP already defines (kept local). */
  collisions: string[];
  /** Hosted tools left out because the server's tool limit was reached. */
  overLimit: string[];
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
/** Fields and handling this package adds around a hosted tool (the v4 surface saves generated files here). */
export interface HostedLocalHook {
  /** The input schema a client lists for the tool. */
  inputSchema(tool: Tool): Tool["inputSchema"];
  /** Runs the call; `forward` sends arguments on to the hosted tool, `tool` is its listing (annotations included). */
  call(name: string, args: Record<string, unknown>, forward: (args: Record<string, unknown>) => Promise<Record<string, unknown>>, tool: Tool): Promise<Record<string, unknown>>;
}

export interface HostedMountOptions {
  firstListWaitMs?: number;
  /** The profile's filter: false leaves a hosted tool out. Default: every tool. */
  includeTool?: (name: string) => boolean;
  /** Mount no tool once the server has this many. Default: no limit. */
  maxTools?: number;
  /** The description a mounted tool gets here. Default: the hosted one. */
  describe?: (tool: Tool) => string;
  /** Runs after each successful mount (another mount can follow it). */
  onMounted?: () => void;
  /** What summer_store_tools calls the hosted tools this profile mounts.
   *  Default: the full profile's store, publishing, board and Grow tools. */
  hostedToolsLabel?: string;
  /** Local fields and handling around each mounted tool. Default: none. */
  local?: HostedLocalHook;
}

export function prepareHostedMount(
  server: McpServer,
  deps: HostedMountDependencies = defaultHostedMountDependencies,
  options: HostedMountOptions = {}
) {
  const firstListWaitMs = options.firstListWaitMs ?? FIRST_LIST_WAIT_MS;
  let listed = false;
  const state: HostedMountState = { status: "idle", tools: [], prompts: [], resources: [], collisions: [], overLimit: [] };
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
      if (!listed) {
        listed = true;
        await waitForMount(firstListWaitMs);
      }
      const result = await listTools(request, extra);
      return {
        ...result,
        tools: result.tools.map((tool) => {
          const hosted = schemas.get(tool.name);
          return hosted ? { ...tool, inputSchema: providerSafeSchema(options.local ? options.local.inputSchema(hosted) : hosted.inputSchema), ...(hosted.annotations ? { annotations: hosted.annotations } : {}), ...(hosted.title ? { title: hosted.title } : {}) } : tool;
        }),
      };
    });
  }

  // tools/call for a name the server does not know yet: a hosted tool whose mount
  // is still running (an agent that calls before it lists). Wait for that mount,
  // at most the first-list cap, then dispatch; an unknown name still errors.
  const callTool = handlers.get("tools/call") as ((request: unknown, extra: unknown) => Promise<unknown>) | undefined;
  if (callTool) {
    server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = (request as { params?: { name?: unknown } }).params?.name;
      if (typeof name === "string" && !(name in registries._registeredTools)) await waitForMount(firstListWaitMs);
      return (await callTool(request, extra)) as never;
    });
  }

  let statusTool: { remove(): void } | null = null;
  let running: Promise<HostedMountState> | null = null;
  let connected: HostedClient | null = null;

  const listedToolCount = () => Object.values(registries._registeredTools).filter((tool) => (tool as { enabled?: boolean }).enabled !== false).length;

  /** Wait for a mount in progress, at most ms; returns at once when none runs. */
  async function waitForMount(ms: number): Promise<void> {
    if (!running || ms <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([running, new Promise<void>((done) => (timer = setTimeout(done, ms)))]);
    clearTimeout(timer);
  }

  const showStatusTool = () => {
    if (statusTool || STORE_TOOLS_STATUS in registries._registeredTools) return;
    statusTool = server.registerTool(
      STORE_TOOLS_STATUS,
      {
        title: "Load the hosted Summer tools",
        description:
          `The ${options.hostedToolsLabel ?? "Summer store, publishing, board and Grow tools"} come from the hosted Summer Engine MCP and are not loaded. Call this to see why and how to fix it (usually: run "summer login --store" in a terminal); it loads them when the sign-in works.`,
        inputSchema: passthroughArgs,
        // Registered after the server's annotation pass, so it carries its own:
        // it asks Summer's servers which tools this sign-in may use and changes nothing.
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
      const failure = hostedConnectFailure(error, 'Recovery: check the network; if it says unauthorized, run "summer login --store --force". Then call summer_store_tools.');
      state.error = {
        code: failure instanceof OAuthError ? failure.code : "store_tools_unreachable",
        message: failure.message.replace(` ${failure.recovery}`, ""),
        recovery: failure.recovery,
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
      if (options.includeTool && !options.includeTool(tool.name)) continue;
      // The limit is on what a client lists: tools a surface keeps unlisted (v4) do not count.
      if (options.maxTools !== undefined && listedToolCount() >= options.maxTools) {
        if (!state.overLimit.includes(tool.name)) state.overLimit.push(tool.name);
        continue;
      }
      schemas.set(tool.name, tool);
      server.registerTool(
        tool.name,
        { description: options.describe ? options.describe(tool) : (tool.description ?? ""), inputSchema: passthroughArgs, ...(tool.annotations ? { annotations: tool.annotations } : {}) },
        async (args: Record<string, unknown>) => {
          try {
            const forward = (sent: Record<string, unknown>) => client.callTool({ name: tool.name, arguments: sent }) as Promise<Record<string, unknown>>;
            return (options.local ? await options.local.call(tool.name, args, forward, tool) : await forward(args)) as never;
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
    connected = client;
    state.status = "mounted";
    delete state.error;
    options.onMounted?.();
    appendMcpLogEvent("mcp:hosted_mounted", {
      tools: state.tools.length,
      prompts: state.prompts.length,
      resources: state.resources.length,
      collisions: state.collisions.length,
      ...(state.overLimit.length ? { overLimit: state.overLimit } : {}),
    });
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

  /**
   * Call a hosted tool whether or not it is listed here (the v4 surface's
   * summer_search and summer_call stay local and forward through this).
   */
  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const after = await mount();
    if (!connected) {
      const error = after.error ?? { code: "store_tools_unavailable", message: "The hosted Summer server is not connected.", recovery: 'Recovery: run "summer login".' };
      // Nothing was sent. A sign-in failure keeps its OAuth code; anything else is the server not answering.
      if (error.code === "store_tools_unreachable" || error.code === "store_tools_unavailable") throw new HostedUnreachableError(error.message, error.recovery);
      throw new OAuthError(error.code, error.message, error.recovery);
    }
    return connected.callTool({ name, arguments: args });
  }

  return { mount, state, call };
}
