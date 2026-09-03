import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";
import type { ZodTypeAny } from "zod";

/**
 * CONTRACT §6: descriptor <-> implementation drift is a build failure.
 *
 * Every MCP tool is registered with a zod raw shape; every tool resource under
 * library/tools/<slug>/resource.yaml carries an `input_schema` (JSON Schema)
 * that agents and the registry read INSTEAD of the zod. When the two drift the
 * agent is told a parameter does not exist (screenshot camera_path), that an
 * optional one is required, or that a required one is optional
 * (library-feedback agent_model) — and the call fails at the SDK boundary.
 *
 * This test converts each registered shape to a structural JSON-Schema-like
 * form (type / required / property names / enum, recursively) and compares it
 * with the descriptor's input_schema. Descriptions, min/max, patterns and
 * defaults are deliberately NOT compared — they are prose and bounds, not
 * shape. zod-to-json-schema is only a transitive dependency (via the MCP SDK),
 * so the extractor here is hand-rolled and covers exactly the zod surface the
 * tool files use; an unknown zod type fails the test loudly instead of being
 * skipped.
 */

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
  getCachedBootDriftNotice: () => null,
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { registerSceneTools } from "./scene-tools.js";
import { registerDebugTools } from "./debug-tools.js";
import { registerVisualTools } from "./visual-tools.js";
import { registerProjectTools } from "./project-tools.js";
import { registerFileTools } from "./file-tools.js";
import { registerAssetTools } from "./asset-tools.js";
import { registerGenerateTools } from "./generate-tools.js";
import { registerCreatorTools } from "./creator-tools.js";
import { registerFeedbackTools } from "./feedback-tools.js";
import { registerScriptTools } from "./script-tools.js";
import { registerPerceptionTools } from "./perception-tools.js";
import { registerSpatialTools } from "./spatial-tools.js";
import { registerNavigationTools } from "./navigation-tools.js";
import { registerLibraryTools } from "./library-tools.js";
import { registerEventTools } from "./event-tools.js";
import { registerFabricateTools } from "./fabricate-tools.js";
import { registerUiTools } from "./ui-tools.js";
import { registerRuntimeTools } from "./runtime-tools.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const toolsDir = join(packageRoot, "library", "tools");

// ---------------------------------------------------------------------------
// Structural schema
// ---------------------------------------------------------------------------

interface Shape {
  type: string;
  required?: string[];
  properties?: Record<string, Shape>;
  items?: Shape;
  enum?: unknown[];
}

function isZod(value: unknown): value is ZodTypeAny {
  return !!value && typeof value === "object" && "_def" in (value as object) && typeof (value as ZodTypeAny).safeParse === "function";
}

function isRawShape(value: unknown): value is Record<string, ZodTypeAny> {
  if (!value || typeof value !== "object" || isZod(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  return entries.length === 0 || entries.every(isZod);
}

/** Unwrap optional/default/effects/etc. Returns the inner schema and whether the
 *  value may be omitted. */
function unwrap(schema: ZodTypeAny): { inner: ZodTypeAny; optional: boolean } {
  let current = schema;
  let optional = false;
  for (;;) {
    const def = current._def as { typeName: string; innerType?: ZodTypeAny; schema?: ZodTypeAny; type?: ZodTypeAny; in?: ZodTypeAny };
    switch (def.typeName) {
      case "ZodOptional":
      case "ZodDefault":
        optional = true;
        current = def.innerType!;
        continue;
      case "ZodNullable":
      case "ZodBranded":
      case "ZodCatch":
      case "ZodReadonly":
        current = def.innerType ?? def.type!;
        continue;
      case "ZodEffects":
        current = def.schema!;
        continue;
      case "ZodPipeline":
        current = def.in!;
        continue;
      default:
        return { inner: current, optional };
    }
  }
}

function zodToShape(schema: ZodTypeAny, path: string): Shape {
  const { inner } = unwrap(schema);
  const def = inner._def as Record<string, unknown> & { typeName: string };
  switch (def.typeName) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber": {
      const checks = (def.checks as Array<{ kind: string }> | undefined) ?? [];
      return { type: checks.some((check) => check.kind === "int") ? "integer" : "number" };
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: [...(def.values as string[])] };
    case "ZodNativeEnum":
      return { type: "string", enum: Object.values(def.values as Record<string, unknown>) };
    case "ZodLiteral":
      return { type: typeof def.value === "number" ? "number" : typeof def.value === "boolean" ? "boolean" : "string", enum: [def.value] };
    case "ZodArray":
      return { type: "array", items: zodToShape(def.type as ZodTypeAny, `${path}[]`) };
    case "ZodTuple": {
      const items = def.items as ZodTypeAny[];
      // Homogeneous tuples ([x,y,z] vectors, [w,h] sizes) describe as a fixed-length array.
      const shapes = items.map((item, index) => zodToShape(item, `${path}[${index}]`));
      const first = shapes[0];
      if (first && shapes.every((shape) => JSON.stringify(shape) === JSON.stringify(first))) {
        return { type: "array", items: first };
      }
      return { type: "array" };
    }
    case "ZodObject":
      return objectShape(def.shape as () => Record<string, ZodTypeAny>, path);
    case "ZodRecord":
      return { type: "object" };
    case "ZodUnion": {
      const options = def.options as ZodTypeAny[];
      const shapes = options.map((option, index) => zodToShape(option, `${path}|${index}`));
      if (shapes.every((shape) => shape.enum)) {
        return { type: shapes[0]!.type, enum: shapes.flatMap((shape) => shape.enum!) };
      }
      const types = new Set(shapes.map((shape) => shape.type));
      return types.size === 1 ? { type: shapes[0]!.type } : { type: "any" };
    }
    case "ZodAny":
    case "ZodUnknown":
      return { type: "any" };
    default:
      throw new Error(`descriptor-parity: unhandled zod type ${def.typeName} at ${path}`);
  }
}

function objectShape(shapeOrGetter: (() => Record<string, ZodTypeAny>) | Record<string, ZodTypeAny>, path: string): Shape {
  const raw = typeof shapeOrGetter === "function" ? shapeOrGetter() : shapeOrGetter;
  const properties: Record<string, Shape> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(raw)) {
    properties[key] = zodToShape(field, `${path}.${key}`);
    if (!unwrap(field).optional) required.push(key);
  }
  return { type: "object", properties, required: required.sort() };
}

/** Reduce a descriptor input_schema to the same structural form. */
function jsonSchemaToShape(schema: Record<string, unknown>, path: string): Shape {
  const rawType = schema.type;
  const type = typeof rawType === "string" ? rawType : Array.isArray(rawType) ? "any" : schema.enum ? "string" : "any";
  const shape: Shape = { type };
  if (Array.isArray(schema.enum)) shape.enum = [...schema.enum];
  if (type === "object" && schema.properties && typeof schema.properties === "object") {
    shape.properties = {};
    for (const [key, value] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
      shape.properties[key] = jsonSchemaToShape(value, `${path}.${key}`);
    }
    shape.required = Array.isArray(schema.required) ? [...(schema.required as string[])].sort() : [];
  }
  if (type === "array" && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    shape.items = jsonSchemaToShape(schema.items as Record<string, unknown>, `${path}[]`);
  }
  return shape;
}

/** Report every structural difference between the zod-derived shape and the
 *  descriptor shape. Empty array = parity. */
function diffShapes(zod: Shape, yaml: Shape, path: string, out: string[] = []): string[] {
  if (zod.type !== "any" && yaml.type !== "any" && zod.type !== yaml.type) {
    out.push(`${path}: type zod=${zod.type} yaml=${yaml.type}`);
  }
  const zodEnum = zod.enum ? [...zod.enum].map(String).sort() : undefined;
  const yamlEnum = yaml.enum ? [...yaml.enum].map(String).sort() : undefined;
  if (zodEnum || yamlEnum) {
    if (!zodEnum || !yamlEnum) {
      out.push(`${path}: enum zod=${JSON.stringify(zodEnum ?? null)} yaml=${JSON.stringify(yamlEnum ?? null)}`);
    } else if (JSON.stringify(zodEnum) !== JSON.stringify(yamlEnum)) {
      out.push(`${path}: enum zod=${JSON.stringify(zodEnum)} yaml=${JSON.stringify(yamlEnum)}`);
    }
  }
  if (zod.properties || yaml.properties) {
    const zodKeys = Object.keys(zod.properties ?? {}).sort();
    const yamlKeys = Object.keys(yaml.properties ?? {}).sort();
    if (JSON.stringify(zodKeys) !== JSON.stringify(yamlKeys)) {
      const onlyZod = zodKeys.filter((key) => !yamlKeys.includes(key));
      const onlyYaml = yamlKeys.filter((key) => !zodKeys.includes(key));
      out.push(
        `${path}: properties differ` +
          (onlyZod.length ? ` (zod only: ${onlyZod.join(", ")})` : "") +
          (onlyYaml.length ? ` (yaml only: ${onlyYaml.join(", ")})` : "")
      );
    }
    if (JSON.stringify(zod.required ?? []) !== JSON.stringify(yaml.required ?? [])) {
      out.push(`${path}: required zod=${JSON.stringify(zod.required ?? [])} yaml=${JSON.stringify(yaml.required ?? [])}`);
    }
    for (const key of zodKeys) {
      if (yaml.properties?.[key]) diffShapes(zod.properties![key]!, yaml.properties[key]!, `${path}.${key}`, out);
    }
  }
  if (zod.items && yaml.items) diffShapes(zod.items, yaml.items, `${path}[]`, out);
  else if (zod.items || yaml.items) out.push(`${path}: items present on ${zod.items ? "zod" : "yaml"} only`);
  return out;
}

// ---------------------------------------------------------------------------
// Collect both sides
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  shape: Shape;
}

function collectRegisteredTools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(...args: unknown[]) {
      const name = args[0] as string;
      // server.tool(name, description?, shape?, annotations?, cb): the raw
      // shape is the first arg between the name and the callback that is a
      // record of zod schemas (or an empty object, meaning "no parameters").
      const middle = args.slice(1, -1);
      const raw = middle.find(isRawShape) ?? middle.find(isZod);
      let shape: Shape;
      if (!raw) shape = { type: "object", properties: {}, required: [] };
      else if (isZod(raw)) shape = zodToShape(raw, name);
      else shape = objectShape(raw, name);
      registered.push({ name, shape });
      return { name };
    },
    prompt() {
      return {};
    },
    server: { getClientVersion: () => undefined },
  } as never;
  for (const register of [
    registerSceneTools,
    registerDebugTools,
    registerVisualTools,
    registerProjectTools,
    registerFileTools,
    registerAssetTools,
    registerGenerateTools,
    registerCreatorTools,
    registerFeedbackTools,
    registerScriptTools,
    registerPerceptionTools,
    registerSpatialTools,
    registerNavigationTools,
    registerLibraryTools,
    registerEventTools,
    registerFabricateTools,
    registerUiTools,
    registerRuntimeTools,
  ]) {
    register(fakeServer);
  }
  return registered;
}

interface Descriptor {
  slug: string;
  toolName: string;
  inputSchema: Record<string, unknown>;
}

function collectDescriptors(): Descriptor[] {
  const out: Descriptor[] = [];
  for (const slug of readdirSync(toolsDir)) {
    const file = join(toolsDir, slug, "resource.yaml");
    if (!statSync(join(toolsDir, slug)).isDirectory()) continue;
    const doc = parseYaml(readFileSync(file, "utf-8")) as {
      surfaces?: { mcp?: { tool_name?: string } };
      input_schema?: Record<string, unknown>;
    };
    const toolName = doc.surfaces?.mcp?.tool_name;
    if (!toolName) continue; // CLI-only descriptor — no MCP registration to compare.
    out.push({ slug, toolName, inputSchema: doc.input_schema ?? {} });
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("repo-lint: descriptor <-> zod parity (library/tools/*/resource.yaml vs registered MCP shapes)", () => {
  const registered = collectRegisteredTools();
  const descriptors = collectDescriptors();
  const byToolName = new Map(descriptors.map((descriptor) => [descriptor.toolName, descriptor]));

  it("registers a sane number of tools and finds the descriptor dir", () => {
    expect(registered.length).toBeGreaterThan(40);
    expect(descriptors.length).toBeGreaterThan(40);
  });

  it("every registered MCP tool has exactly one descriptor naming it", () => {
    const registeredNames = registered.map((tool) => tool.name).sort();
    const missing = registeredNames.filter((name) => !byToolName.has(name));
    expect(missing, "registered tools without a library/tools descriptor").toEqual([]);
    const counts = new Map<string, number>();
    for (const descriptor of descriptors) counts.set(descriptor.toolName, (counts.get(descriptor.toolName) ?? 0) + 1);
    expect([...counts].filter(([, count]) => count > 1)).toEqual([]);
  });

  it("every descriptor with an mcp.tool_name has a live registration", () => {
    const registeredNames = new Set(registered.map((tool) => tool.name));
    const orphaned = descriptors.filter((descriptor) => !registeredNames.has(descriptor.toolName)).map((d) => d.slug);
    expect(orphaned, "descriptors naming an MCP tool that is not registered").toEqual([]);
  });

  it("input_schema matches the zod shape: type, property names, required keys, enums (recursive)", () => {
    const drift: string[] = [];
    for (const tool of registered) {
      const descriptor = byToolName.get(tool.name);
      if (!descriptor) continue; // reported by the test above
      const yamlShape = jsonSchemaToShape(descriptor.inputSchema, tool.name);
      for (const line of diffShapes(tool.shape, yamlShape, tool.name)) {
        drift.push(`library/tools/${descriptor.slug}/resource.yaml — ${line}`);
      }
    }
    expect(drift).toEqual([]);
  });
});
