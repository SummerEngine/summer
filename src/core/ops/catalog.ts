import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadLibraryIndex } from "../library-search.js";
import { PACKAGE_ROOT } from "../package-root.js";
import { CONTRACT_VERSION, isLocalOp, legacyNames, mcpNameOf, MIN_APPROVAL, type Approval, type Effect, type Provider } from "./contract.js";
import { ENGINE_SPLIT_OPS, engineOpDef, isSplitOp, splitInputSchema } from "./engine.js";

/**
 * One searchable row per operation, the same shape the hosted server's
 * summer_search answers with, so local and cloud hits merge into one list.
 */
export interface CatalogEntry {
  name: string;
  title: string;
  summary: string;
  effect: Effect;
  approval: Approval;
  provider: Provider;
  status: "stable" | "preview" | "deprecated";
  available: boolean;
  /** The MCP tool that runs it directly in this session, when there is one. */
  mcpTool?: string;
  tags?: string[];
  legacy?: string[];
  /** The exact input JSON Schema (search results and describe carry it). */
  input?: Record<string, unknown>;
}

type Authority = Partial<Record<"filesystem" | "editor_mutation" | "network" | "credentials" | "publish", boolean>>;

/** A local tool's effect from its registry authority: scene edits and project files are writes. */
function effectOf(authority: Authority | undefined): Effect {
  if (authority?.publish) return "publish";
  if (authority?.editor_mutation || authority?.filesystem || authority?.credentials) return "write";
  return "read";
}

const titleOf = (summary: string, op: string) => {
  const sentence = summary.split(/(?<=\.)\s/)[0]?.replace(/\.$/, "") ?? "";
  return sentence && sentence.length <= 60 ? sentence : op.replace(/^[a-z]+\./, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
};

let entriesCache: CatalogEntry[] | null = null;

type IndexedTool = ReturnType<typeof loadLibraryIndex>[number];

function entryFor(op: string, toolName: string, tool: IndexedTool, legacy: string): CatalogEntry {
  // Engine operations carry their own title, summary and effect (engine.ts);
  // other local operations fall back to the descriptor.
  const def = engineOpDef(op);
  const effect = def?.effect ?? effectOf(tool.authority as Authority | undefined);
  const summary = def?.summary ?? (tool.summary ?? "").slice(0, 300);
  return {
    name: op,
    title: def?.title ?? titleOf(summary, op),
    summary,
    effect,
    approval: MIN_APPROVAL[effect],
    provider: op.startsWith("engine.") ? "engine" : "local",
    status: tool.status === "preview" ? "preview" : "stable",
    available: true,
    // A split operation is its own tool; every other one runs under its 3.x name.
    mcpTool: isSplitOp(op) ? mcpNameOf(op) : toolName,
    tags: [...(tool.use_when ?? []), ...(tool.facets?.domains ?? [])],
    legacy: [legacy],
  };
}

/**
 * The operations this package runs (engine and local), from the shipped
 * library index and legacy-names.json. Their MCP tool is the 3.x name the
 * local server registers (engine tools keep their names in 4.0), except the
 * operations split out of a mixed 3.x tool (engine.ts), which are their own.
 */
export function localEntries(): CatalogEntry[] {
  if (entriesCache) return entriesCache;
  const tools = new Map(loadLibraryIndex().filter((entry) => entry.kind === "tool" && entry.mcp_tool_name).map((entry) => [entry.mcp_tool_name as string, entry]));
  const out = new Map<string, CatalogEntry>();
  // The tool an operation was renamed from comes before the tools merged into it.
  const rows = Object.entries(legacyNames()).sort(([, a], [, b]) => Number(a.kind === "merge") - Number(b.kind === "merge"));
  for (const [name, row] of rows) {
    if (!isLocalOp(row.op) || out.has(row.op)) continue;
    const toolName = name.split("#")[0];
    const tool = tools.get(toolName);
    if (!tool) continue;
    if (name.includes("#") && !isSplitOp(row.op)) continue;
    out.set(row.op, entryFor(row.op, toolName, tool, name));
  }
  entriesCache = [...out.values()];
  return entriesCache;
}

function descriptorSchema(toolName: string): Record<string, unknown> | null {
  const record = loadLibraryIndex().find((candidate) => candidate.kind === "tool" && candidate.mcp_tool_name === toolName);
  const slug = record?.id.replace(/^tool\//, "");
  if (!slug) return null;
  try {
    const descriptor = parseYaml(readFileSync(join(PACKAGE_ROOT, "library", "tools", slug, "resource.yaml"), "utf8")) as { input_schema?: Record<string, unknown> };
    return descriptor.input_schema ?? null;
  } catch {
    return null;
  }
}

/** The input JSON Schema of a local operation, from its library descriptor (a split operation: cut from its tool's). */
export function localInputSchema(op: string): Record<string, unknown> | null {
  const split = ENGINE_SPLIT_OPS[op];
  if (split) return splitInputSchema(split, descriptorSchema(split.tool));
  const toolName = localEntries().find((candidate) => candidate.name === op)?.mcpTool;
  return toolName ? descriptorSchema(toolName) : null;
}

/**
 * A local operation in the contract's wire form (registry/schemas/operation.schema.json):
 * what ops.describe answers and what the contract test validates.
 */
export function localWireForm(op: string): Record<string, unknown> | null {
  const entry = localEntries().find((candidate) => candidate.name === op);
  if (!entry) return null;
  const def = engineOpDef(op);
  const legacy = Object.entries(legacyNames())
    .filter(([, row]) => row.op === op)
    .map(([name]) => name)
    .sort();
  return {
    contract: CONTRACT_VERSION,
    name: op,
    title: entry.title,
    summary: entry.summary,
    effect: entry.effect,
    approval: entry.approval,
    provider: entry.provider,
    auth: def?.auth ?? "none",
    input: localInputSchema(op) ?? { type: "object" },
    output: { type: "object" },
    ...(legacy.length ? { legacy } : {}),
    ...(entry.mcpTool && entry.mcpTool !== mcpNameOf(op) ? { mcpName: entry.mcpTool } : {}),
    status: entry.status,
    since: "4.0",
    ...(entry.tags?.length ? { tags: entry.tags } : {}),
    examples: def ? [def.example] : [{ input: {}, note: entry.title }],
  };
}

/**
 * The first problem a JSON Schema's top level finds in an input: a missing
 * required field or, when the schema is closed, an unknown one. Null when
 * there is none (deeper checks are the tool's own).
 */
export function missingInput(schema: Record<string, unknown> | null, input: Record<string, unknown>): string | null {
  if (!schema) return null;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const absent = required.find((field) => input[field] === undefined);
  if (absent) return `${absent}: required.`;
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(input).find((field) => !(field in properties));
    if (unknown) return `${unknown}: not a field of this operation.`;
  }
  return null;
}
