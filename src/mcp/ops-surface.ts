import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool, type ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { localEntries, localInputSchema, localWireForm, missingInput, type CatalogEntry } from "../core/ops/catalog.js";
import { answerOfHosted, describeFromShipped, hostedCallFailure, searchEverywhere } from "../core/ops/cloud.js";
import { errorAnswer, isLocalOp, legacyNames, localToolsFor, mcpNameOf, resolveOpName, type Answer } from "../core/ops/contract.js";
import { ENGINE_SPLIT_OPS, engineOpDef, isSplitOp, renderOpRefs, splitToolArgs, type EngineSplitDef } from "../core/ops/engine.js";
import { answerOfEngineResult, codedLocalFailure, engineFailure, textsOf } from "../core/ops/engine-answer.js";
import { TAKES_OUT, withOutField, type FileSaver } from "../core/ops/save-files.js";
import { loadLibraryIndex } from "../core/library-search.js";
import { FOOTER_SUFFIX } from "../core/library-read.js";
import type { HostedLocalHook } from "./hosted-mount.js";

/**
 * The v4 surface of the local MCP (`summer mcp --surface v4`, SUMMER_SURFACE=v4):
 * one catalog of Summer operations instead of one tool per feature.
 *
 * - Listed: the engine operations under their 3.x names (the core build loop
 *   keeps its tools) plus the operations split out of mixed 3.x tools,
 *   docs.search and docs.read, the hosted server's direct tools (mounted from
 *   its v4 surface), summer_search and summer_call.
 * - An engine tool here is its operation: a short summary (the how-to is its
 *   guide, docs.read tool/<slug>), annotations from its effect, and the one
 *   answer shape, with engine_not_running and the other codes instead of
 *   plain text.
 * - Every other local 3.x tool stays registered but unlisted: summer_call
 *   runs it by its operation name or its old name, through the same handler.
 *   The legacy toolset lists them again under their 3.x names.
 * - Cloud operations run on the hosted server: summer_call forwards them to
 *   the hosted summer_call with the person's sign-in; summer_search merges
 *   the hosted hits with the local ones.
 */

export const SUMMER_SEARCH = "summer_search";
export const SUMMER_CALL = "summer_call";

/**
 * The first-game look rule. It opens the engine instructions because clients
 * keep only the start of long server instructions (Codex: the first 512
 * characters), and a project's first frame decides whether the person keeps
 * going. The same rule is in the AGENTS.md block (project-memory/agent-instructions.ts).
 */
export const FIRST_GAME_LOOK_RULE =
  "First game in a new project: make it look finished, even if they asked for a quick prototype, because the first frame decides if they keep going. " +
  "Keep their features and raise the look: sky and sun with shadows, fog, a texture on every surface, real models for player, characters and props (starter project and summer_assets_search first, never capsules or boxes as final art), one palette, a styled UI font. " +
  "Before you say it is ready, play it and check a screenshot of the running game.";

export const OPS_MCP_INSTRUCTIONS =
  "Summer Engine MCP. " +
  FIRST_GAME_LOOK_RULE +
  " Write GDScript files directly; create scenes and import assets through Summer while the project is open. summer_get_project_context tells you which project you are connected to. " +
  "Listed tools are the common jobs; for anything else, summer_search describes the job in words and returns the operation and its exact input, then summer_call runs it. " +
  "More than 3 scene edits: one summer_run_script with scenePath. Each engine tool's full guide: summer_docs_read. Long work answers with a job: jobs.wait. " +
  "Going live: skill/release-checklist, then store.go_live with the person's yes; a game is live once Summer's automated checks pass, so never tell anyone to wait for a review. Prices and other live changes may answer needs_approval with a link: give it to the person. " +
  "Opening the Summer editor and playing the game in a window is allowed and expected: summer_play, then summer_screenshot or summer_frame_shot to see it; close what you opened, one editor at a time.";

/** The assets profile's version: no engine tools, so it names none. */
export const OPS_MCP_ASSETS_INSTRUCTIONS =
  "Summer MCP, assets profile, operation catalog: generation and the Summer asset library, no engine tools. " +
  "Read skill/summer-assets with summer_docs_read, then the asset's skill: stop at the file, skip its engine steps. " +
  "For a job no listed tool does, summer_search returns the operation and its exact input, then summer_call runs it. " +
  "Generation costs credits: confirm first (dryRun shows the estimate). Long work answers with a job: jobs.wait. " +
  "Files save into the project's asset folder, or the folder in out; the answer gives localPath.";

/** Runs a tool on the hosted server's v4 surface (hosted-mount.ts). */
export interface CloudCaller {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface OpsSurfaceOptions {
  /** Keep the engine operations listed (profiles with engine tools). */
  engine: boolean;
  cloud: CloudCaller;
  /** The legacy toolset: list every local 3.x name too, each running as it did in 3.x. */
  legacy?: boolean;
  /** Saves generated files on this machine (`out`, localPath); shared with the mounted hosted tools. */
  files: FileSaver;
  /** A Studio page op in the running app's own Studio tab (core/ops/studio-page.ts); null sends it to Summer's server. */
  studio?: (op: string, input: Record<string, unknown>) => Promise<Answer | null>;
}

type Handler = (...args: unknown[]) => Promise<unknown>;
type Registry = { _registeredTools: Record<string, RegisteredTool> };
type Shape = Record<string, z.ZodTypeAny>;

const DOCS_ALIASES: ReadonlyArray<[string, string]> = [
  ["summer_docs_search", "summer_search_library"],
  ["summer_docs_read", "summer_read_library"],
];

/** Local operations listed with the engine tools: they create and open the project the engine tools need, with no shell. */
const LOCAL_PROJECT_TOOLS = ["summer_projects_create_local", "summer_projects_open_local"];

/** Listed with the engine tools although its operation is docs.engine_api: the offline engine class reference. */
const ENGINE_REFERENCE = "summer_api_docs";

/** Its v4 description, within the 300-character summary rule; the full text stays on the 3.x surface. */
export const ENGINE_REFERENCE_SUMMARY =
  "Look up an engine class offline before writing script code: inherits, properties, methods, signals and constants, or one member. Lists only members declared on that class (walk inherits). No engine needed. Next: summer_run_script.";

/** The read footer in this surface's words: feedback goes through summer_call (docs.feedback is not listed). */
export const V4_FOOTER_SUFFIX = 'If this entry is wrong, stale, or you deviate from it, report via summer_call {"op":"docs.feedback"}.';

/** A library read's result with the v4 footer (and the v4 names in its description of the footer). */
function withV4Footer(result: unknown): unknown {
  const record = result as { content?: Array<{ type?: string; text?: unknown }> } | null;
  if (!record || !Array.isArray(record.content)) return result;
  return {
    ...record,
    content: record.content.map((part) =>
      part.type === "text" && typeof part.text === "string" ? { ...part, text: part.text.split(FOOTER_SUFFIX).join(V4_FOOTER_SUFFIX) } : part
    ),
  };
}

const LIBRARY_READS = new Set(["summer_read_library", "summer_get_agent_playbook"]);

/** The answer as tool content: compact JSON text (plus any image the tool returned) and structured content. */
function toolResult(answer: Answer, raw?: unknown) {
  const content = raw && typeof raw === "object" ? (raw as { content?: unknown }).content : undefined;
  const images = Array.isArray(content) ? (content as Array<{ type?: string }>).filter((part) => part?.type === "image") : [];
  return {
    content: [{ type: "text" as const, text: JSON.stringify(answer) }, ...images],
    // A client that reads structuredContent alone would drop the image.
    ...(images.length ? {} : { structuredContent: answer as unknown as Record<string, unknown> }),
    ...(answer.ok ? {} : { isError: true }),
  };
}

/** A non-engine local 3.x tool's result as the one answer shape (a few, such as apps.dock, still need the engine). */
function answerOfLocal(result: unknown, op: string, effect: "read" | "write"): Answer {
  const record = (result && typeof result === "object" ? result : {}) as { isError?: boolean };
  const [first = ""] = textsOf(result);
  if (record.isError) {
    const engine = engineFailure(textsOf(result).join("\n\n"), op, { effect });
    if (!engine.ok && ["engine_not_running", "engine_lacks_op", "conflict"].includes(engine.error.code)) return engine;
  }
  let payload: unknown = first;
  try {
    payload = JSON.parse(first);
  } catch {
    payload = first ? { text: first } : {};
  }
  if (record.isError) {
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const coded = codedLocalFailure(body);
    if (coded) return coded;
    const message = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : first.slice(0, 500) || "The tool failed.";
    const details = { tool: payload };
    if (/not found|does not exist|no such/i.test(message)) return errorAnswer("not_found", message, { details });
    return errorAnswer("invalid_input", message, { details });
  }
  return { ok: true, status: "done", result: payload };
}

/** MCP annotations from an operation's effect (SPEC §4.1); engine operations never need a retry key. */
export function annotationsForEffect(effect: "read" | "write", openWorld: boolean, title: string): ToolAnnotations {
  return effect === "read"
    ? { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld }
    : { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: openWorld };
}

/** Library slug, summary and network authority of each local tool (registry/generated/index.json). */
function toolFacts(): Map<string, { slug: string; summary: string; network: boolean }> {
  const out = new Map<string, { slug: string; summary: string; network: boolean }>();
  for (const entry of loadLibraryIndex()) {
    if (entry.kind !== "tool" || !entry.mcp_tool_name) continue;
    out.set(entry.mcp_tool_name, { slug: entry.id.replace(/^tool\//, ""), summary: entry.summary ?? "", network: Boolean(entry.authority?.network) });
  }
  return out;
}

const PARAM_LIMIT = 200;
/** A sentence end: not the dot of "e.g.", "i.e." or "etc.", and followed by a new sentence. */
const SENTENCE_END = /(?<!\be\.g|\bi\.e|\betc)[.!?](?=\s+["'`(A-Z0-9])/g;

/** A parameter description cut to its whole sentences within PARAM_LIMIT characters; the guide has it whole. */
export function shortParamDescription(text: string): string {
  const clean = text.trim();
  if (clean.length <= PARAM_LIMIT) return clean;
  let cut = -1;
  for (const match of clean.matchAll(SENTENCE_END)) {
    if (match.index + 1 > PARAM_LIMIT) break;
    cut = match.index + 1;
  }
  return cut >= 40 ? clean.slice(0, cut) : `${clean.slice(0, PARAM_LIMIT).replace(/\s+\S*$/, "")}…`;
}

/** 3.x tool names that shared descriptions mention, as this surface lists them. */
const V4_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/summer_camera_bookmark(?: \(list them with action:"list"\))?/g, "summer_engine_save_camera_bookmark (list: summer_engine_list_camera_bookmarks)"],
  [/summer_read_library/g, "summer_docs_read"],
  [/summer_search_library/g, "summer_docs_search"],
  [/summer_library_feedback/g, 'summer_call {"op":"docs.feedback"}'],
];

export function v4Text(text: string): string {
  return V4_NAMES.reduce((out, [pattern, name]) => out.replace(pattern, name), text);
}

/** A schema's descriptions in this surface's words, cut to whole sentences when `short`. */
function v4Schema(schema: unknown, short: boolean): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const record = schema as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  if (typeof record.description === "string") out.description = v4Text(short ? shortParamDescription(record.description) : record.description);
  if (record.properties && typeof record.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(record.properties as Record<string, unknown>).map(([key, value]) => [key, v4Schema(value, short)]));
  }
  if (record.items) out.items = v4Schema(record.items, short);
  for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(record[key])) out[key] = (record[key] as unknown[]).map((branch) => v4Schema(branch, short));
  return out;
}

export function applyOpsSurface(server: McpServer, options: OpsSurfaceOptions): void {
  const tools = (server as unknown as Registry)._registeredTools;
  const names = legacyNames();
  const facts = toolFacts();
  const entries = new Map<string, CatalogEntry>(localEntries().map((entry) => [entry.name, entry]));
  /** The 3.x handler of each engine tool, before the v4 answer wraps it (summer_call runs these). */
  const rawHandlers = new Map<string, Handler>();
  /** Tools listed with the v4 engine shape; their parameter descriptions are cut in tools/list. */
  const engineTools = new Set<string>();

  // docs.search and docs.read under their 4.0 names, same handlers.
  for (const [alias, original] of DOCS_ALIASES) {
    const tool = tools[original];
    if (!tool || tools[alias]) continue;
    const shape = (tool.inputSchema as { shape?: Shape } | undefined)?.shape ?? {};
    server.tool(alias, v4Text(tool.description ?? ""), shape, tool.annotations ?? {}, (async (args: Record<string, unknown>, extra: unknown) => {
      const result = await (tool.handler as Handler)(args, extra);
      return LIBRARY_READS.has(original) ? withV4Footer(result) : result;
    }) as never);
  }

  // Engine tools (and the operations split out of the two mixed ones) are listed with the v4 shape.
  const mixed = new Set(Object.values(ENGINE_SPLIT_OPS).map((def) => def.tool));
  const splitByTool = new Map(Object.keys(ENGINE_SPLIT_OPS).map((op) => [mcpNameOf(op), op]));
  const listed = new Set<string>(DOCS_ALIASES.map(([alias]) => alias));
  if (options.engine) {
    for (const name of Object.keys(tools)) {
      if (!names[name]?.op.startsWith("engine.") || mixed.has(name)) continue;
      engineTools.add(name);
      listed.add(name);
    }
    for (const [op, def] of Object.entries(ENGINE_SPLIT_OPS)) {
      if (!tools[def.tool]) continue;
      engineTools.add(mcpNameOf(op));
      listed.add(mcpNameOf(op));
    }
    if (tools[ENGINE_REFERENCE]) {
      listed.add(ENGINE_REFERENCE);
      tools[ENGINE_REFERENCE].update({ title: "Look up an engine class", description: ENGINE_REFERENCE_SUMMARY });
    }
  }

  /** The tool that runs an operation in this session, for summaries that name it. */
  const toolOf = (op: string): string | undefined => {
    if (op === "docs.search") return "summer_docs_search";
    if (op === "docs.read") return "summer_docs_read";
    const tool = isSplitOp(op) ? mcpNameOf(op) : entries.get(op)?.mcpTool;
    return tool && listed.has(tool) ? tool : undefined;
  };
  const guideOf = (toolName: string) => {
    const slug = facts.get(toolName)?.slug;
    return slug ? `tool/${slug}` : undefined;
  };
  const describe = (op: string, toolName: string) => {
    const def = engineOpDef(op)!;
    const guide = guideOf(toolName);
    return `${renderOpRefs(def.summary, toolOf)}${guide ? `\nGuide: summer_docs_read {"id":"${guide}"}` : ""}`;
  };

  for (const name of engineTools) {
    const tool = tools[name];
    const op = names[name]?.op;
    const def = op ? engineOpDef(op) : null;
    if (!tool || !op || !def) continue; // split tools are registered below
    const handler = tool.handler as Handler;
    rawHandlers.set(name, handler);
    const answerOptions = { effect: def.effect, guide: guideOf(name) };
    tool.update({
      title: def.title,
      description: describe(op, name),
      annotations: annotationsForEffect(def.effect, Boolean(facts.get(name)?.network), def.title),
      callback: (async (...args: unknown[]) => {
        const raw = await handler(...args);
        return toolResult(answerOfEngineResult(raw, op, answerOptions), raw);
      }) as never,
    });
  }

  // projects.create_local and projects.open_local: the one answer shape, like the engine tools.
  const localProjectTools = options.engine ? LOCAL_PROJECT_TOOLS.filter((name) => tools[name] && entries.has(names[name]?.op ?? "")) : [];
  for (const name of localProjectTools) listed.add(name);
  for (const name of localProjectTools) {
    const tool = tools[name];
    const op = names[name].op;
    const entry = entries.get(op)!;
    const handler = tool.handler as Handler;
    rawHandlers.set(name, handler);
    tool.update({
      title: entry.title,
      description: renderOpRefs(entry.summary, toolOf),
      annotations: annotationsForEffect(entry.effect === "read" ? "read" : "write", Boolean(facts.get(name)?.network), entry.title),
      callback: (async (...args: unknown[]) => {
        const raw = await handler(...args);
        return toolResult(answerOfLocal(raw, op, "write"), raw);
      }) as never,
    });
  }

  // Operations split out of a mixed 3.x tool: their own tool, the 3.x handler with the action fixed.
  for (const [op, def] of Object.entries(ENGINE_SPLIT_OPS)) {
    const base = tools[def.tool];
    if (!options.engine || !base) continue;
    const shape = splitShape(def, (base.inputSchema as { shape?: Shape } | undefined)?.shape ?? {});
    const answerOptions = { effect: def.effect, guide: guideOf(def.tool) };
    server.tool(
      mcpNameOf(op),
      describe(op, def.tool),
      shape,
      annotationsForEffect(def.effect, Boolean(facts.get(def.tool)?.network), def.title),
      (async (args: Record<string, unknown>, extra: unknown) => {
        const raw = await (base.handler as Handler)(splitToolArgs(def, args ?? {}), extra);
        return toolResult(answerOfEngineResult(raw, op, answerOptions), raw);
      }) as never
    );
    tools[mcpNameOf(op)].update({ title: def.title });
  }

  // The rest stay callable; the legacy toolset lists them under their 3.x names.
  for (const [name, tool] of Object.entries(tools)) {
    if (listed.has(name)) continue;
    const op = names[name]?.op;
    if (!options.legacy || !op) {
      tool.disable();
      continue;
    }
    const use = mixed.has(name)
      ? Object.entries(ENGINE_SPLIT_OPS).filter(([, def]) => def.tool === name).map(([splitOp]) => toolOf(splitOp) ?? splitOp).join(", ")
      : op;
    tool.update({ description: `3.x name; use ${use}. ${renderOpRefs(entries.get(op)?.summary ?? facts.get(name)?.summary ?? "", toolOf)}`.trim() });
  }

  // tools/list: local tools name tools as this surface lists them, and an engine tool's
  // parameter descriptions are cut to whole sentences (the guide has them whole).
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<{ tools: Tool[] }>> })._requestHandlers;
  const listTools = handlers.get("tools/list");
  if (listTools) {
    server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const result = await listTools(request, extra);
      return {
        ...result,
        tools: result.tools.map((tool) => (listed.has(tool.name) ? { ...tool, inputSchema: v4Schema(tool.inputSchema, engineTools.has(tool.name)) as Tool["inputSchema"] } : tool)),
      };
    });
  }

  /** The tool and arguments that run a local operation here, or null. */
  function localCall(name: string, resolved: string, input: Record<string, unknown>): { tool: string; args: Record<string, unknown>; split?: true } | null {
    const split: EngineSplitDef | undefined = ENGINE_SPLIT_OPS[resolved];
    // A split operation runs its 3.x tool with the action fixed; called by that 3.x name, it runs as called.
    if (split && name !== split.tool) return tools[split.tool] ? { tool: split.tool, args: splitToolArgs(split, input), split: true } : null;
    if (tools[name]) return { tool: name, args: input };
    const own = entries.get(resolved)?.mcpTool;
    const tool = own && tools[own] ? own : localToolsFor(resolved).find((candidate) => tools[candidate]);
    return tool ? { tool, args: input } : null;
  }

  async function validate(toolName: string, args: Record<string, unknown>, op: string): Promise<{ data: unknown } | { error: Answer }> {
    const schema = tools[toolName].inputSchema as
      | { safeParseAsync?: (v: unknown) => Promise<{ success: boolean; data?: unknown; error?: { issues: Array<{ path: (string | number)[]; message: string }> } }> }
      | undefined;
    if (!schema?.safeParseAsync) return { data: undefined };
    const parsed = await schema.safeParseAsync(args);
    if (parsed.success) return { data: parsed.data };
    const issue = parsed.error?.issues[0];
    const path = issue?.path.join(".") || "(input)";
    const guide = guideOf(toolName);
    return {
      error: errorAnswer("invalid_input", `${path}: ${issue?.message ?? "invalid value"}.`, {
        details: { path },
        next: guide && op.startsWith("engine.") ? { op: "docs.read", input: { id: guide } } : { op: "ops.describe", input: { name: op } },
      }),
    };
  }

  async function runLocal(op: string, call: { tool: string; args: Record<string, unknown>; split?: true }, extra: unknown, dryRun: boolean, input: Record<string, unknown>): Promise<Answer> {
    const { tool: toolName, args } = call;
    // A split operation's own fields first: its 3.x tool took them as optional (its fixed action may come along; it is replaced).
    const split = call.split ? ENGINE_SPLIT_OPS[op] : undefined;
    const missing = split ? missingInput(localInputSchema(op), Object.fromEntries(Object.entries(input).filter(([key]) => !(key in split.fixed)))) : null;
    if (missing) {
      const guide = guideOf(toolName);
      return errorAnswer("invalid_input", missing, { next: guide ? { op: "docs.read", input: { id: guide } } : { op: "ops.describe", input: { name: op } } });
    }
    const checked = await validate(toolName, args, op);
    if ("error" in checked) return checked.error;
    const entry = entries.get(op);
    if (dryRun) {
      // The default dry run (SPEC §5.3): the input is checked and the call described; nothing reaches the engine.
      const target = typeof args.scenePath === "string" ? ` on ${args.scenePath}` : typeof args.path === "string" ? ` on ${args.path}` : "";
      return {
        ok: true,
        status: "dry_run",
        preview: { summary: `${entry?.title ?? op}${target}: the input is valid. Nothing was done.`, changes: [], approval: entry?.approval ?? "none", estimate: null, valid: true },
      };
    }
    const handler = rawHandlers.get(toolName) ?? (tools[toolName].handler as Handler);
    const result = checked.data === undefined ? await handler(extra) : await handler(checked.data, extra);
    const raw = LIBRARY_READS.has(toolName) ? withV4Footer(result) : result;
    const def = engineOpDef(op);
    return def ? answerOfEngineResult(raw, op, { effect: def.effect, guide: guideOf(toolName) }) : answerOfLocal(raw, op, entry?.effect === "read" ? "read" : "write");
  }

  async function search(query: string, area: string | undefined, limit: number): Promise<Answer> {
    const { items, warning } = await searchEverywhere(query, { area, limit }, (name, args) => options.cloud.call(name, args), (toolName) => tools[toolName]?.enabled === true);
    return { ok: true, status: "done", result: { items }, ...(warning ? { warnings: [warning] } : {}) };
  }

  server.tool(
    SUMMER_SEARCH,
    "Find any Summer operation by describing the job in plain words: engine, assets, store, pricing, analytics and the rest. Returns the best matches with their exact input schema, effect and approval. Next: summer_call with the name.",
    {
      query: z.string().min(1).max(300).describe('The job in plain words: "lower my game\'s price", "add a light to the scene".'),
      area: z.string().regex(/^[a-z]+$/).optional().describe("Only this area: engine, assets, store, pricing, analytics..."),
      limit: z.number().int().min(1).max(20).optional().describe("Most results (default 5)."),
    },
    { title: "Find a Summer operation", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (async ({ query, area, limit }: { query: string; area?: string; limit?: number }) => toolResult(await search(query, area, limit ?? 5))) as never
  );

  server.tool(
    SUMMER_CALL,
    "Run any Summer operation by name (from summer_search) with its input. Engine operations run here; cloud ones run on Summer's server with the same approvals: money, publishing and live changes answer needs_approval with a link. 3.x tool names work too.",
    {
      op: z.string().min(1).max(80).optional().describe("The operation name, e.g. engine.add_node or pricing.set_base (or a 3.x tool name)."),
      // Agents reach for `name` (the field summer_search answers with); it means op.
      name: z.string().min(1).max(80).optional().describe("Same as op."),
      input: z.record(z.unknown()).optional().describe("The operation's input, matching the schema summer_search returned."),
      dryRun: z.boolean().optional().describe("Check and describe the call without doing it."),
      idempotencyKey: z.string().min(1).max(128).optional().describe("Retry key for writes; reuse it only to retry the identical call."),
    },
    { title: "Run a Summer operation", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    (async (
      { op, name: opAlias, input, dryRun, idempotencyKey }: { op?: string; name?: string; input?: Record<string, unknown>; dryRun?: boolean; idempotencyKey?: string },
      extra: unknown
    ) => {
      const name = (op ?? opAlias ?? "").trim();
      if (!name) {
        return toolResult(errorAnswer("invalid_input", "Pass op: the operation name from summer_search, e.g. engine.add_node.", { next: { op: "ops.search" } }));
      }
      if (op !== undefined && opAlias !== undefined && op.trim() !== opAlias.trim()) {
        return toolResult(errorAnswer("invalid_input", `op ("${op}") and name ("${opAlias}") differ; pass one operation name.`, { next: { op: "ops.search" }, details: { path: "name" } }));
      }
      const args = input ?? {};
      // A split operation's own tool name, or a mixed 3.x tool whose action picks the operation.
      const action = typeof args.action === "string" ? args.action : typeof args.mode === "string" ? args.mode : undefined;
      const resolved = splitByTool.get(name) ?? (action ? names[`${name}#${action}`]?.op : undefined) ?? resolveOpName(name);
      // The catalog itself: local operations are searched and described here as well.
      if (resolved === "ops.search" && typeof args.query === "string") {
        return toolResult(await search(args.query, typeof args.area === "string" ? args.area : undefined, typeof args.limit === "number" ? args.limit : 5));
      }
      if (resolved === "ops.describe" && typeof args.name === "string" && isLocalOp(resolveOpName(args.name))) {
        const wire = localWireForm(resolveOpName(args.name));
        return toolResult(
          wire
            ? { ok: true, status: "done", result: { operation: wire } }
            : errorAnswer("not_found", `No operation is named "${args.name}".`, { next: { op: "ops.search", input: { query: args.name } } })
        );
      }
      // A 3.x name this server registers runs its 3.x tool unchanged (local
      // options such as summer_app_publish's dir keep working), wherever its
      // 4.0 operation runs.
      if (names[name] && tools[name] && name !== SUMMER_CALL && name !== SUMMER_SEARCH && !isLocalOp(resolved)) {
        return toolResult(await runLocal(resolved, { tool: name, args }, extra, dryRun === true, args));
      }
      if (isLocalOp(resolved)) {
        const call = localCall(name, resolved, args);
        if (!call) return toolResult(errorAnswer("not_in_profile", `${resolved} is not served by this profile.`, { next: { say: "Run the MCP with --profile engine." } }));
        return toolResult(await runLocal(resolved, call, extra, dryRun === true, args));
      }
      // The running Summer app answers its own Studio tab's ops itself; else Summer's server does.
      if (options.studio && dryRun !== true) {
        const inApp = await options.studio(resolved, args);
        if (inApp) return toolResult(inApp);
      }
      // `out` stays here: this package saves the files (core/ops/save-files.ts).
      const { input: sent, out } = options.files.take(resolved, args);
      let raw: Record<string, unknown>;
      // Describing a cloud operation works signed out: the shipped catalog has it.
      const describe = (answer: Answer) => (resolved === "ops.describe" && typeof args.name === "string" ? describeFromShipped(args.name, answer) : null) ?? answer;
      try {
        raw = await options.cloud.call(SUMMER_CALL, { op: name, ...(input ? { input: sent } : {}), ...(dryRun ? { dryRun } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) });
      } catch (error) {
        return toolResult(describe(hostedCallFailure(error, { op: resolved, dryRun: dryRun === true, idempotencyKey })));
      }
      return toolResult(describe(await options.files.finish(resolved, answerOfHosted(raw), out)));
    }) as never
  );
}

/** A split operation's input shape: its fields from the 3.x tool's shape, the required ones required. */
function splitShape(def: EngineSplitDef, base: Shape): Shape {
  const shape: Shape = {};
  for (const field of def.fields) {
    const type = base[field];
    if (!type) continue;
    shape[field] = def.required?.includes(field) && type instanceof z.ZodOptional ? (type.unwrap() as z.ZodTypeAny).describe(type.description ?? "") : type;
  }
  return shape;
}

/**
 * The hosted direct tools on the v4 surface. Those that take `out`
 * (summer_assets_generate_image, summer_assets_get, summer_jobs_wait, ...)
 * show it in their listed input, and a call keeps it here and saves the files
 * the answer names. A call that throws answers in the one shape too
 * (hostedCallFailure), never with a plain "retry".
 */
export function hostedFileTools(files: FileSaver): HostedLocalHook {
  const ops = new Map([...TAKES_OUT].map((op) => [mcpNameOf(op), op]));
  const sent = async (tool: Tool, args: Record<string, unknown>, forward: (args: Record<string, unknown>) => Promise<Record<string, unknown>>) => {
    try {
      return await forward(args);
    } catch (error) {
      const failure = hostedCallFailure(error, {
        op: ops.get(tool.name) ?? tool.name,
        dryRun: args.dryRun === true,
        idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined,
        read: tool.annotations?.readOnlyHint === true,
      });
      return toolResult(failure) as Record<string, unknown>;
    }
  };
  return {
    inputSchema: (tool) => {
      const op = ops.get(tool.name);
      return op ? (withOutField(op, tool.inputSchema) as Tool["inputSchema"]) : tool.inputSchema;
    },
    call: async (name, args, forward, tool) => {
      const op = ops.get(name);
      if (!op) return sent(tool, args, forward);
      const { input, out } = files.take(op, args);
      const raw = await sent(tool, input, forward);
      const answer = answerOfHosted(raw);
      const saved = await files.finish(op, answer, out);
      if (saved === answer) return raw;
      const content = Array.isArray(raw.content) ? (raw.content as Array<{ type?: string }>) : [];
      return { ...raw, content: [{ type: "text", text: JSON.stringify(saved) }, ...content.filter((part) => part.type !== "text")], ...(raw.structuredContent ? { structuredContent: saved } : {}) };
    },
  };
}
