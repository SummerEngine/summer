import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { answerOfHosted, searchEverywhere } from "../core/ops/cloud.js";
import { FOOTER_SUFFIX } from "../core/library-read.js";
import { errorAnswer, isLocalOp, legacyNames, localToolsFor, resolveOpName, type Answer } from "../core/ops/contract.js";

/**
 * The v4 surface of the local MCP (`summer mcp --surface v4`, SUMMER_SURFACE=v4):
 * one catalog of Summer operations instead of one tool per feature.
 *
 * - Listed: the engine operations under their 3.x names (the core build loop
 *   keeps its tools), docs.search and docs.read, the hosted server's direct
 *   tools (mounted from its v4 surface), summer_search and summer_call.
 * - Every other local 3.x tool stays registered but unlisted: summer_call
 *   runs it by its operation name or its old name, through the same handler.
 * - Cloud operations run on the hosted server: summer_call forwards them to
 *   the hosted summer_call with the person's sign-in; summer_search merges
 *   the hosted hits with the local ones.
 */

export const SUMMER_SEARCH = "summer_search";
export const SUMMER_CALL = "summer_call";

export const OPS_MCP_INSTRUCTIONS =
  "Summer Engine MCP, operation catalog. Call summer_get_project_context first when Summer Engine is open. " +
  "Listed tools are the common jobs; for anything else, summer_search describes the job in words and returns the operation and its exact input, then summer_call runs it. " +
  "More than 3 scene edits: one summer_run_script. Long work answers with a job: jobs.wait. " +
  "Publishing, prices and other live changes answer needs_approval with a link: give it to the person; nothing changes until they approve.";

/** Runs a tool on the hosted server's v4 surface (hosted-mount.ts). */
export interface CloudCaller {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface OpsSurfaceOptions {
  /** Keep the engine operations listed (profiles with engine tools). */
  engine: boolean;
  cloud: CloudCaller;
}

type Registry = { _registeredTools: Record<string, RegisteredTool> };

const DOCS_ALIASES: ReadonlyArray<[string, string]> = [
  ["summer_docs_search", "summer_search_library"],
  ["summer_docs_read", "summer_read_library"],
];

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

function text(answer: Answer) {
  return { content: [{ type: "text" as const, text: JSON.stringify(answer) }], ...(answer.ok ? {} : { isError: true }) };
}

/** A local 3.x tool's result as the one answer shape. */
function answerOfLocal(result: unknown): Answer {
  const record = (result && typeof result === "object" ? result : {}) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const first = record.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text ?? "";
  let payload: unknown = first;
  try {
    payload = JSON.parse(first);
  } catch {
    payload = first ? { text: first } : {};
  }
  if (record.isError) {
    const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const message = typeof body.message === "string" ? body.message : first.slice(0, 500) || "The tool failed.";
    if (/not running|no api-token|engine_not_running/i.test(first)) {
      return errorAnswer("engine_not_running", "Summer Engine is not running, or no project is open.", { next: { say: "Open the project in Summer Engine, then try again." } });
    }
    if (/engine_lacks_op/.test(first)) return errorAnswer("engine_lacks_op", message, { next: { say: "Update Summer Engine." } });
    // The engine's own structured failure travels whole in details (receipts, failure_reason).
    const details = { tool: payload };
    if (/not found|does not exist|no such/i.test(message)) return errorAnswer("not_found", message, { details });
    return errorAnswer("invalid_input", message, { details });
  }
  return { ok: true, status: "done", result: payload };
}

export function applyOpsSurface(server: McpServer, options: OpsSurfaceOptions): void {
  const tools = (server as unknown as Registry)._registeredTools;
  const names = legacyNames();

  // docs.search and docs.read under their 4.0 names, same handlers.
  for (const [alias, original] of DOCS_ALIASES) {
    const tool = tools[original];
    if (!tool || tools[alias]) continue;
    const shape = (tool.inputSchema as { shape?: Record<string, z.ZodTypeAny> } | undefined)?.shape ?? {};
    const description = (tool.description ?? "").replace(/summer_library_feedback/g, 'summer_call {"op":"docs.feedback"}').replace(/summer_read_library/g, "summer_docs_read").replace(/summer_search_library/g, "summer_docs_search");
    server.tool(alias, description, shape, tool.annotations ?? {}, (async (args: Record<string, unknown>, extra: unknown) => {
      const result = await (tool.handler as (a: unknown, e: unknown) => Promise<unknown>)(args, extra);
      return LIBRARY_READS.has(original) ? withV4Footer(result) : result;
    }) as never);
  }

  // Listed: engine operations (when the profile has them) and the docs aliases. The rest stay callable.
  const listed = new Set<string>(DOCS_ALIASES.map(([alias]) => alias));
  for (const [name, tool] of Object.entries(tools)) {
    const op = names[name]?.op;
    if (listed.has(name)) continue;
    if (options.engine && name === ENGINE_REFERENCE) {
      tool.update({ title: "Look up an engine class", description: ENGINE_REFERENCE_SUMMARY });
      continue;
    }
    if (options.engine && op?.startsWith("engine.")) continue;
    tool.disable();
  }

  async function runLocal(toolName: string, args: Record<string, unknown>, extra: unknown): Promise<Answer> {
    const tool = tools[toolName];
    if (!tool) return errorAnswer("not_found", `No local tool ${toolName}.`);
    const schema = tool.inputSchema as { safeParseAsync?: (v: unknown) => Promise<{ success: boolean; data?: unknown; error?: { issues: Array<{ path: (string | number)[]; message: string }> } }> } | undefined;
    if (schema?.safeParseAsync) {
      const parsed = await schema.safeParseAsync(args);
      if (!parsed.success) {
        const issue = parsed.error?.issues[0];
        const path = issue?.path.join(".") || "(input)";
        return errorAnswer("invalid_input", `${path}: ${issue?.message ?? "invalid value"}.`, { details: { path }, next: { op: "ops.describe", input: { name: resolveOpName(toolName) } } });
      }
      const result = await (tool.handler as (a: unknown, e: unknown) => Promise<unknown>)(parsed.data, extra);
      return answerOfLocal(LIBRARY_READS.has(toolName) ? withV4Footer(result) : result);
    }
    return answerOfLocal(await (tool.handler as (e: unknown) => Promise<unknown>)(extra));
  }

  server.tool(
    SUMMER_SEARCH,
    "Find any Summer operation by describing the job in plain words: engine, assets, store, pricing, analytics and the rest. Returns the best matches with their exact input schema, effect and approval. Next: summer_call with the name.",
    {
      query: z.string().min(1).max(300).describe('The job in plain words: "lower my game\'s price", "add a light to the scene".'),
      area: z.string().regex(/^[a-z]+$/).optional().describe("Only this area: engine, assets, store, pricing, analytics..."),
      limit: z.number().int().min(1).max(20).optional().describe("Most results (default 5)."),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    (async ({ query, area, limit }: { query: string; area?: string; limit?: number }) => {
      const { items, warning } = await searchEverywhere(query, { area, limit: limit ?? 5 }, (name, args) => options.cloud.call(name, args), (toolName) => tools[toolName]?.enabled === true);
      return text({ ok: true, status: "done", result: { items }, ...(warning ? { warnings: [warning] } : {}) });
    }) as never
  );

  server.tool(
    SUMMER_CALL,
    "Run any Summer operation by name (from summer_search) with its input. Engine operations run here; cloud ones run on Summer's server with the same approvals: money, publishing and live changes answer needs_approval with a link. 3.x tool names work too.",
    {
      op: z.string().min(1).max(80).describe("The operation name, e.g. engine.add_node or pricing.set_base (or a 3.x tool name)."),
      input: z.record(z.unknown()).optional().describe("The operation's input, matching the schema summer_search returned."),
      dryRun: z.boolean().optional().describe("Check and describe the call without doing it."),
      idempotencyKey: z.string().min(1).max(128).optional().describe("Retry key for writes; reuse it only to retry the identical call."),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    (async ({ op, input, dryRun, idempotencyKey }: { op: string; input?: Record<string, unknown>; dryRun?: boolean; idempotencyKey?: string }, extra: unknown) => {
      const name = op.trim();
      const resolved = resolveOpName(name);
      // A 3.x name this server registers runs its 3.x tool unchanged (local
      // options such as summer_app_publish's dir keep working), wherever its
      // 4.0 operation runs.
      if (names[name] && tools[name] && name !== SUMMER_CALL && name !== SUMMER_SEARCH) {
        if (dryRun) return text(errorAnswer("unsupported", `${name} is a 3.x tool and has no dry run. Use its 4.0 operation ${resolved} when it is available.`));
        return text(await runLocal(name, input ?? {}, extra));
      }
      if (isLocalOp(resolved)) {
        if (dryRun) return text(errorAnswer("unsupported", `${resolved} runs in Summer Engine and has no dry run yet. Read the scene first (engine.get_scene_tree), then call it.`));
        const toolName = tools[name] ? name : localToolsFor(resolved).find((candidate) => tools[candidate]);
        if (!toolName) return text(errorAnswer("not_in_profile", `${resolved} is not served by this profile.`, { next: { say: "Run the MCP with --profile engine." } }));
        return text(await runLocal(toolName, input ?? {}, extra));
      }
      try {
        return text(answerOfHosted(await options.cloud.call(SUMMER_CALL, { op: name, ...(input ? { input } : {}), ...(dryRun ? { dryRun } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) })));
      } catch (error) {
        return text(errorAnswer("not_signed_in", `Cloud operations need the Summer sign-in: ${error instanceof Error ? error.message : String(error)}`, { next: { say: "Run: npx -y summer-engine login" } }));
      }
    }) as never
  );
}
