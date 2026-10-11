import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "./server.js";
import { providerSafeSchema, STRICT_PROVIDER_FORMATS } from "./provider-safe-schema.js";

/**
 * Guard for the schemas hosts forward to model providers. Kimi Code sent
 * summer_align_distribute_3d's tuple `axis` to Moonshot and every prompt failed
 * with HTTP 400 ("items must be an object"). This walks the real tools/list
 * output, not the zod shapes or descriptors, because the failure lives in the
 * serialization.
 */

// The JSON Schema keywords strict providers accept (OpenAI strict mode's list;
// Moonshot is narrower on tuples and refs, not wider).
const ALLOWED_KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "anyOf",
  "enum", "const", "description", "title", "default", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "pattern", "format", "minLength", "maxLength",
]);

function strictProviderViolations(schema: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      out.push(`${path}: not a schema object`);
      return;
    }
    const n = node as Record<string, unknown>;
    for (const key of Object.keys(n)) {
      if (!ALLOWED_KEYWORDS.has(key) && !(path === "" && key === "$schema")) out.push(`${path}: unsupported keyword ${key}`);
    }
    if (Array.isArray(n.items)) out.push(`${path}: tuple items (items must be an object)`);
    if (Array.isArray(n.type)) out.push(`${path}: type array`);
    if (typeof n.format === "string" && !STRICT_PROVIDER_FORMATS.has(n.format)) out.push(`${path}: unsupported format ${n.format}`);
    if (n.type === "array" && n.items === undefined) out.push(`${path}: array without items`);
    for (const [key, child] of Object.entries((n.properties as Record<string, unknown>) ?? {})) walk(child, `${path}/properties/${key}`);
    if (n.items !== undefined && !Array.isArray(n.items)) walk(n.items, `${path}/items`);
    if (typeof n.additionalProperties === "object") walk(n.additionalProperties, `${path}/additionalProperties`);
    ((n.anyOf as unknown[]) ?? []).forEach((child, i) => walk(child, `${path}/anyOf/${i}`));
  };
  walk(schema, "");
  return out;
}

describe("tools/list schemas are accepted by strict providers", () => {
  let client: Client;
  let tools: Tool[];
  let registered: number;

  beforeAll(async () => {
    const { server, getRegisteredToolCount } = createMcpServer();
    registered = getRegisteredToolCount();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "strict-provider-guard", version: "1.0.0" });
    await client.connect(clientSide);
    ({ tools } = await client.listTools());
  });

  afterAll(async () => {
    await client.close();
  });

  it("lists every registered tool", () => {
    expect(tools.length).toBe(registered);
  });

  it("no tool schema uses tuples, $ref, type arrays or keywords outside the strict subset", () => {
    const violations = tools.flatMap((tool) => strictProviderViolations(tool.inputSchema).map((v) => `${tool.name} ${v}`));
    expect(violations).toEqual([]);
  });

  it("publishes vectors as fixed-length arrays with one items schema", () => {
    const schema = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, any> };
    expect(schema("summer_align_distribute_3d").properties.axis).toMatchObject({ type: "array", minItems: 3, maxItems: 3, items: { type: "number" } });
    expect(schema("summer_capture_gameplay").properties.steps.items.properties.drag.properties.from).toEqual({ type: "array", minItems: 2, maxItems: 2, items: { type: "number" } });
  });

  it("still rejects a wrong-length vector at runtime", async () => {
    const result = await client.callTool({
      name: "summer_align_distribute_3d",
      arguments: { scenePath: "res://main.tscn", subjectPaths: ["A", "B"], mode: "align_min", axis: [1, 0] },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Input validation error/);
  });
});

describe("providerSafeSchema", () => {
  it("turns a tuple into an array with one items schema and exact bounds", () => {
    expect(providerSafeSchema({ type: "array", items: [{ type: "number" }, { type: "number" }], minItems: 2, maxItems: 2 })).toEqual({
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 2,
    });
    expect(providerSafeSchema({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] })).toEqual({
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
      minItems: 2,
      maxItems: 2,
    });
    expect(providerSafeSchema({ type: "array", items: [{ type: "string" }], additionalItems: { type: "number" } })).toEqual({
      type: "array",
      items: { anyOf: [{ type: "string" }, { type: "number" }] },
      minItems: 1,
    });
  });

  it("inlines local refs, keeping the referring node's own keywords", () => {
    const schema = {
      type: "object",
      properties: {
        start: { type: "array", items: [{ type: "number" }, { $ref: "#/properties/start/items/0" }] },
        end: { $ref: "#/properties/start", description: "End point." },
        size: { $ref: "#/definitions/size" },
      },
      definitions: { size: { type: "number", minimum: 0 } },
    };
    expect(providerSafeSchema(schema)).toEqual({
      type: "object",
      properties: {
        start: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
        end: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "End point." },
        size: { type: "number", minimum: 0 },
      },
    });
  });

  it("accepts any value where a recursive ref would loop", () => {
    expect(providerSafeSchema({ type: "object", properties: { child: { $ref: "#" } } })).toEqual({
      type: "object",
      properties: { child: { type: "object", properties: { child: {} } } },
    });
  });

  it("turns a type array into anyOf, drops unsupported formats and string-only propertyNames", () => {
    expect(providerSafeSchema({ type: ["string", "number"], description: "Value." })).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
      description: "Value.",
    });
    expect(providerSafeSchema({ type: "string", format: "uri" })).toEqual({ type: "string" });
    expect(providerSafeSchema({ type: "string", format: "uuid" })).toEqual({ type: "string", format: "uuid" });
    expect(providerSafeSchema({ type: "object", propertyNames: { type: "string" }, additionalProperties: {} })).toEqual({ type: "object", additionalProperties: {} });
  });

  it("leaves data and property names alone", () => {
    const schema = {
      type: "object",
      default: { items: [1, 2], $ref: "#/x", format: "uri" },
      properties: {
        mode: { type: "string", enum: ["a"] },
        format: { type: "string" },
        propertyNames: { type: "string" },
        items: { type: "array", items: { type: "string" } },
      },
    };
    expect(providerSafeSchema(schema)).toEqual(schema);
  });
});
