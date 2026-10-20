import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadLibraryIndex } from "../library-search.js";
import { PACKAGE_ROOT } from "../package-root.js";
import { CONTRACT_VERSION, isLocalOp, legacyNames, LOCAL_RUNNERS, mcpNameOf, MIN_APPROVAL, opFromCli, resolveOpName, type Approval, type Effect, type Provider } from "./contract.js";
import { ENGINE_SPLIT_OPS, engineOpDef, isSplitOp, splitInputSchema } from "./engine.js";
import { shippedCloudEntries, shippedTitle } from "./public-catalog.js";

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
  /** A cloud operation listed from the shipped catalog while no one is signed in: it runs after `summer login`. */
  needsSignIn?: true;
  /** Search words only, never printed: the library's topics for docs.search ("add multiplayer" is a how-to). */
  topics?: string[];
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
 * The local operations that reach Summer with the person's sign-in (the
 * account and the store sign-in `summer login` makes; `summer login --store`
 * for the store sign-in alone). Every other local one works signed out.
 */
const SIGNED_IN_LOCAL_OPS: ReadonlySet<string> = new Set(["economy.sync_items", "store.upload_file", "store.go_live", "store.set_details", "apps.publish_folder", "content.make"]);

/**
 * Local operations that change Summer's records although their registry
 * authority names no local file or publish: store.set_details saves the store
 * page draft (players see nothing until it goes live).
 */
const REMOTE_WRITE_LOCAL_OPS: ReadonlySet<string> = new Set(["store.set_details"]);

type IndexedTool = ReturnType<typeof loadLibraryIndex>[number];

function entryFor(op: string, toolName: string, tool: IndexedTool, legacy: string): CatalogEntry {
  // Engine operations carry their own title, summary and effect (engine.ts);
  // other local operations fall back to the descriptor.
  const def = engineOpDef(op);
  const effect = def?.effect ?? (REMOTE_WRITE_LOCAL_OPS.has(op) ? "write" : effectOf(tool.authority as Authority | undefined));
  const summary = def?.summary ?? (tool.summary ?? "").slice(0, 300);
  return {
    name: op,
    // The hosted catalog's title when it has the op too (docs.search: "Search Summer docs", not "Search").
    title: def?.title ?? shippedTitle(op) ?? titleOf(summary, op),
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
  // The tool an operation was renamed from comes before the tools merged into it;
  // then the local operations a 3.x tool runs although its 3.x name maps to a cloud one.
  const rows: Array<[string, { op: string; kind?: string }]> = [
    ...Object.entries(legacyNames()).sort(([, a], [, b]) => Number(a.kind === "merge") - Number(b.kind === "merge")),
    ...Object.entries(LOCAL_RUNNERS).map(([op, name]): [string, { op: string }] => [name, { op }]),
  ];
  for (const [name, row] of rows) {
    if (!isLocalOp(row.op) || out.has(row.op)) continue;
    const toolName = name.split("#")[0];
    const tool = tools.get(toolName);
    if (!tool) continue;
    if (name.includes("#") && !isSplitOp(row.op)) continue;
    out.set(row.op, entryFor(row.op, toolName, tool, name));
  }
  const docsSearch = out.get("docs.search");
  if (docsSearch) out.set("docs.search", { ...docsSearch, topics: libraryTopics() });
  entriesCache = [...out.values()];
  return entriesCache;
}

/** The words of every skill, template and example slug (multiplayer, fps, lighting...): what the library teaches. */
function libraryTopics(): string[] {
  const slugs = loadLibraryIndex()
    .filter((entry) => entry.kind !== "tool" && entry.kind !== "reference")
    .flatMap((entry) => entry.id.replace(/^[a-z]+\//, "").split("-"));
  return [...new Set(slugs)].filter((word) => word.length > 2 && !/^\d/.test(word));
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
/**
 * The operation when it is a real one (this package runs it, or the shipped
 * catalog lists it), else null. Usage lines name an operation only through
 * this, so a word someone typed (`summer engine my-secret-game`) never
 * leaves the machine as an operation name.
 */
export function knownOp(op: string | null | undefined): string | null {
  if (!op) return null;
  return localEntries().some((entry) => entry.name === op) || shippedTitle(op) !== undefined ? op : null;
}

/**
 * The operation `summer <area> <action>` runs. Agents often type a 3.x tool
 * name as the action (`summer engine summer_get_scene_tree`, `summer engine
 * camera-bookmark`, `summer engine search_library`): those resolve through
 * legacy-names.json, so a 3.x name runs instead of failing not_found.
 */
export function resolveCliOp(area: string, action: string): string {
  const op = opFromCli(area, action);
  if (knownOp(op)) return op;
  const [cleanArea, word] = op.split(".") as [string, string];
  const bare = word.replace(/^summer_/, "").replace(new RegExp(`^${cleanArea}_`), "");
  for (const candidate of [`${cleanArea}.${bare}`, resolveOpName(`summer_${bare}`), resolveOpName(word)]) {
    if (knownOp(candidate)) return candidate;
  }
  return op;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/** The area's real actions nearest to what was typed, nearest first (kebab-case, as typed on the CLI). */
export function closestActions(op: string, limit = 3): string[] {
  const [area, action = ""] = op.split(".");
  const typed = action.replace(/^summer_/, "");
  const actions = new Set(
    [...localEntries(), ...shippedCloudEntries()].filter((entry) => entry.name.startsWith(`${area}.`)).map((entry) => entry.name.slice(area.length + 1))
  );
  const score = (candidate: string) => (candidate.includes(typed) || typed.includes(candidate) ? 0 : editDistance(typed, candidate));
  return [...actions]
    .sort((a, b) => score(a) - score(b) || a.localeCompare(b))
    .slice(0, limit)
    .map((candidate) => candidate.replace(/_/g, "-"));
}

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
    auth: def?.auth ?? (SIGNED_IN_LOCAL_OPS.has(op) ? "account" : "none"),
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
