import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Hosts hand each tool's inputSchema to the model provider as the function's
 * parameters, and strict providers (Moonshot/Kimi, OpenAI strict mode,
 * Gemini) accept only a subset of JSON Schema: one provider rejecting one
 * tool fails the whole request with HTTP 400, before any tool runs. The SDK's
 * zod conversion, and the hosted tools' zod 4 output, carry shapes outside
 * that subset:
 *
 * - tuples (`z.tuple`) as an array of schemas in `items` (or `prefixItems`),
 *   plus `additionalItems`; Moonshot answers "items must be an object";
 * - a zod value reused in one shape as a `$ref` into the same schema
 *   ("#/properties/start/items/0"), with no definitions to resolve against;
 * - a union of scalars as a `type` array (["string", "number"]);
 * - string formats such as `uri`, and `propertyNames: { type: "string" }`
 *   on records (JSON keys are strings anyway).
 *
 * providerSafeSchema rewrites them at the export boundary: a tuple becomes an
 * array with one `items` schema and exact minItems/maxItems, every local
 * `$ref` is inlined, a `type` array becomes an `anyOf`, and the format and
 * redundant propertyNames are dropped. zod still validates every call, so a
 * wrong-length vector is rejected exactly as before.
 */

type JsonObject = Record<string, unknown>;

/** String formats OpenAI strict mode accepts; other providers accept no more. */
export const STRICT_PROVIDER_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"]);

// Where a schema holds subschemas: one, a list, or a name -> schema map.
const SCHEMA_KEYS = new Set(["items", "additionalItems", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedItems", "unevaluatedProperties"]);
const SCHEMA_LIST_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]);

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

function resolvePointer(root: unknown, ref: string): unknown {
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

function uniqueSchemas(schemas: unknown[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const schema of schemas) seen.set(JSON.stringify(schema), schema);
  return [...seen.values()];
}

function rewrite(schema: unknown, root: unknown, expanding: string[]): unknown {
  if (!isObject(schema)) return schema;
  const child = (value: unknown) => rewrite(value, root, expanding);

  const { $ref, ...rest } = schema;
  if (typeof $ref === "string" && ($ref === "#" || $ref.startsWith("#/"))) {
    // A recursive shape cannot be inlined; accept any value there and let zod validate it.
    const target = expanding.includes($ref) ? {} : rewrite(resolvePointer(root, $ref), root, [...expanding, $ref]);
    return { ...(isObject(target) ? target : {}), ...(child(rest) as JsonObject) };
  }

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalItems" || key === "prefixItems") continue;
    if (SCHEMA_KEYS.has(key)) out[key] = Array.isArray(value) ? value.map(child) : child(value);
    else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) out[key] = value.map(child);
    else if (SCHEMA_MAP_KEYS.has(key) && isObject(value)) out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, child(sub)]));
    else out[key] = value;
  }

  if (Array.isArray(schema.type) && !("anyOf" in out)) {
    delete out.type;
    out.anyOf = schema.type.map((type) => ({ type }));
  }
  if (typeof out.format === "string" && !STRICT_PROVIDER_FORMATS.has(out.format)) delete out.format;
  if (isObject(out.propertyNames) && Object.keys(out.propertyNames).length === 1 && out.propertyNames.type === "string") delete out.propertyNames;

  const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : null;
  if (tuple) {
    const extra = Array.isArray(schema.prefixItems) ? schema.items : schema.additionalItems;
    const open = extra !== undefined && extra !== false;
    const members = uniqueSchemas([...tuple, ...(isObject(extra) ? [extra] : [])].map(child));
    out.items = members.length === 1 ? members[0] : members.length === 0 ? {} : { anyOf: members };
    out.minItems ??= tuple.length;
    if (!open) out.maxItems ??= tuple.length;
  }
  return out;
}

export function providerSafeSchema<T>(schema: T): T {
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
