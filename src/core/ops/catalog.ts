import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadLibraryIndex } from "../library-search.js";
import { PACKAGE_ROOT } from "../package-root.js";
import { isLocalOp, legacyNames, MIN_APPROVAL, type Approval, type Effect, type Provider } from "./contract.js";

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

/**
 * The operations this package runs (engine and local), from the shipped
 * library index and legacy-names.json. Their MCP tool is the 3.x name the
 * local server registers (engine tools keep their names in 4.0).
 */
export function localEntries(): CatalogEntry[] {
  if (entriesCache) return entriesCache;
  const tools = new Map(loadLibraryIndex().filter((entry) => entry.kind === "tool" && entry.mcp_tool_name).map((entry) => [entry.mcp_tool_name as string, entry]));
  const out = new Map<string, CatalogEntry>();
  for (const [name, row] of Object.entries(legacyNames())) {
    if (name.includes("#") || !isLocalOp(row.op) || out.has(row.op)) continue;
    const tool = tools.get(name);
    if (!tool) continue;
    const effect = effectOf(tool.authority as Authority | undefined);
    const summary = (tool.summary ?? "").slice(0, 300);
    out.set(row.op, {
      name: row.op,
      title: titleOf(summary, row.op),
      summary,
      effect,
      approval: MIN_APPROVAL[effect],
      provider: row.op.startsWith("engine.") ? "engine" : "local",
      status: tool.status === "preview" ? "preview" : "stable",
      available: true,
      mcpTool: name,
      tags: [...(tool.use_when ?? []), ...(tool.facets?.domains ?? [])],
      legacy: [name],
    });
  }
  entriesCache = [...out.values()];
  return entriesCache;
}

/** The input JSON Schema of a local operation, from its library descriptor. */
export function localInputSchema(op: string): Record<string, unknown> | null {
  const entry = localEntries().find((candidate) => candidate.name === op);
  const toolName = entry?.mcpTool;
  if (!toolName) return null;
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
