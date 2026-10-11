import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Hosts hand each tool's inputSchema to the model provider as the function's
 * parameters, and strict providers (Moonshot/Kimi, OpenAI strict mode,
 * Gemini) accept only a subset of JSON Schema: one provider rejecting one
 * tool fails the whole request with HTTP 400, before any tool runs. The SDK's
 * zod conversion emits three shapes outside that subset:
 *
 * - tuples (`z.tuple`) as an array of schemas in `items`, plus
 *   `additionalItems`; Moonshot answers "items must be an object";
 * - a zod value reused in one shape as a `$ref` into the same schema
 *   ("#/properties/start/items/0"), with no definitions to resolve against;
 * - a union of scalars as a `type` array (["string", "number"]).
 *
 * providerSafeSchema rewrites them at the export boundary: a tuple becomes an
 * array with one `items` schema and exact minItems/maxItems, every local
 * `$ref` is inlined, and a `type` array becomes an `anyOf`. zod still
 * validates every call, so a wrong-length vector is rejected exactly as before.
 */

type Json = unknown;
type JsonObject = Record<string, Json>;

// Keywords whose values are data, not schemas.
const DATA_KEYS = new Set(["enum", "const", "default", "examples"]);

const isObject = (value: Json): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

function resolvePointer(root: Json, ref: string): Json {
  let node = root;
  for (const raw of ref.slice(2).split("/")) {
    if (raw === "") continue;
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isObject(node)) node = node[key];
    else return undefined;
  }
  return node;
}

function uniqueSchemas(schemas: Json[]): Json[] {
  const seen = new Map<string, Json>();
  for (const schema of schemas) seen.set(JSON.stringify(schema), schema);
  return [...seen.values()];
}

function rewrite(node: Json, root: Json, expanding: string[]): Json {
  if (Array.isArray(node)) return node.map((child) => rewrite(child, root, expanding));
  if (!isObject(node)) return node;

  const { $ref, ...rest } = node;
  if (typeof $ref === "string" && ($ref === "#" || $ref.startsWith("#/"))) {
    // A recursive shape cannot be inlined; accept any value there and let zod validate it.
    const target = expanding.includes($ref) ? {} : rewrite(resolvePointer(root, $ref), root, [...expanding, $ref]);
    return { ...(isObject(target) ? target : {}), ...(rewrite(rest, root, expanding) as JsonObject) };
  }

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "additionalItems" || key === "prefixItems") continue;
    out[key] = DATA_KEYS.has(key) ? value : rewrite(value, root, expanding);
  }

  if (Array.isArray(node.type) && !("anyOf" in out)) {
    delete out.type;
    out.anyOf = node.type.map((type) => ({ type }));
  }

  const tuple = Array.isArray(node.prefixItems) ? node.prefixItems : Array.isArray(node.items) ? node.items : null;
  if (tuple) {
    const extra = Array.isArray(node.prefixItems) ? node.items : node.additionalItems;
    const open = extra !== undefined && extra !== false;
    const members = uniqueSchemas([...tuple, ...(isObject(extra) ? [extra] : [])].map((child) => rewrite(child, root, expanding)));
    out.items = members.length === 1 ? members[0] : members.length === 0 ? {} : { anyOf: members };
    out.minItems ??= tuple.length;
    if (!open) out.maxItems ??= tuple.length;
  }
  return out;
}

export function providerSafeSchema<T extends Json>(schema: T): T {
  const out = rewrite(schema, schema, []);
  if (isObject(out)) {
    // Every local $ref is inlined, so the definition tables are dead weight.
    delete out.definitions;
    delete out.$defs;
  }
  return out as T;
}

/**
 * Wrap the SDK's tools/list so every tool's inputSchema leaves the server in
 * the provider-safe form. Call after the first registerTool (the SDK installs
 * its tools/list handler then).
 */
export function serveProviderSafeToolSchemas(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{ tools: Tool[] }>> })._requestHandlers;
  const listTools = handlers.get("tools/list");
  if (!listTools) return;
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await listTools(request, extra);
    return { ...result, tools: result.tools.map((tool) => ({ ...tool, inputSchema: providerSafeSchema(tool.inputSchema) })) };
  });
}
