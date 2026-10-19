import { Command } from "commander";
import { CLI_AREAS } from "../../core/ops/areas.js";
import { closestActions, localEntries, localInputSchema, localWireForm, missingInput, resolveCliOp } from "../../core/ops/catalog.js";
import { shippedCloudEntries, shippedWireForm } from "../../core/ops/public-catalog.js";
import { answerOfHosted, callHostedV4, describeFromShipped, hostedCallFailure, searchEverywhere, type HostedCall } from "../../core/ops/cloud.js";
import { errorAnswer, isLocalOp, localToolsFor, OP_NAME, resolveOpName, type Answer, type ErrorCode, type JobRef } from "../../core/ops/contract.js";
import { ENGINE_SPLIT_OPS, engineOpDef, splitToolArgs } from "../../core/ops/engine.js";
import { codedLocalFailure, engineFailure, engineNotRunning } from "../../core/ops/engine-answer.js";
import { loadLibraryIndex } from "../../core/library-search.js";
import { FileSaver, withOutField } from "../../core/ops/save-files.js";
import { dispatchTool, EngineUnavailableError, ToolResultError } from "../../core/capabilities/tool-dispatch.js";
import { noteCliError, noteCliHosted } from "../../core/cli-usage.js";

/**
 * The CLI view of the operation catalog (on by default; SUMMER_SURFACE=v3 leaves it out):
 *
 *   summer <area> <action> [--<field> <value> ...] [--input '<json>'] [--dry-run] [--idempotency-key <k>] [--wait] [--json]
 *   summer whoami
 *   summer ops search <words...> | summer ops describe <op>
 *
 * Engine and local operations run in this process (the same functions
 * `summer tool` runs); cloud operations run on the hosted Summer server
 * through its summer_call, with the person's sign-in.
 */

export { CLI_AREAS };

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema };

const RESERVED_FLAGS = new Set(["json", "dry-run", "wait", "idempotency-key", "input"]);
const camel = (flag: string) => flag.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

/** A flag's field: camelCase (`--scene-path` is scenePath), or snake_case when the schema names it so (`--look-at` is look_at). */
function fieldName(flag: string, schema: JsonSchema | null): string {
  const snake = flag.replace(/-/g, "_");
  return snake !== flag && schema?.properties?.[snake] && !schema.properties[camel(flag)] ? snake : camel(flag);
}

function coerce(value: string | true, schema: JsonSchema | undefined): unknown {
  const type = Array.isArray(schema?.type) ? schema?.type[0] : schema?.type;
  if (value === true) return true;
  if (type === "number" || type === "integer") return Number(value);
  if (type === "boolean") return value === "true";
  if (type === "string") return value;
  if (type === "object" || type === "array") {
    try {
      return JSON.parse(value);
    } catch {
      return type === "array" ? value.split(",") : value;
    }
  }
  return /^(-?\d+(\.\d+)?|true|false)$/.test(value) ? JSON.parse(value) : value;
}

export interface ParsedCall {
  input: Record<string, unknown>;
  json: boolean;
  dryRun: boolean;
  wait: boolean;
  idempotencyKey?: string;
}

/** `--max-items 3 --tag a --tag b --no-loop` -> `{ maxItems: 3, tag: ["a", "b"], loop: false }`, typed by the schema. */
export function parseCallFlags(argv: readonly string[], schema: JsonSchema | null): ParsedCall {
  const out: ParsedCall = { input: {}, json: false, dryRun: false, wait: false };
  const fields: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}". Pass fields as --name value.`);
    const [rawName, inline] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (rawName === "json") out.json = true;
    else if (rawName === "dry-run") out.dryRun = true;
    else if (rawName === "wait") out.wait = true;
    else if (rawName === "idempotency-key" || rawName === "input") {
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`--${rawName} needs a value.`);
      if (rawName === "input") {
        const parsed = JSON.parse(value) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--input must be a JSON object.");
        Object.assign(out.input, parsed);
      } else out.idempotencyKey = value;
    } else if (rawName.startsWith("no-") && !RESERVED_FLAGS.has(rawName)) {
      fields[fieldName(rawName.slice(3), schema)] = false;
    } else {
      const name = fieldName(rawName, schema);
      const next = argv[index + 1];
      const value: string | true = inline ?? (next !== undefined && !next.startsWith("--") ? (index++, next) : true);
      const property = schema?.properties?.[name];
      const typed = property?.type === "array" ? coerce(value, property.items) : coerce(value, property);
      if (property?.type === "array") fields[name] = [...((fields[name] as unknown[]) ?? []), ...(Array.isArray(typed) ? typed : [typed])];
      else fields[name] = name in fields ? [...[fields[name]].flat(), typed] : typed;
    }
  }
  out.input = { ...out.input, ...fields };
  // --dry-run anywhere makes a dry run, whatever the input says: allow rules for dry runs rely on it (installer/cli-permissions.ts).
  if (out.dryRun) delete out.input.dryRun;
  return out;
}

export interface OpsCliDeps {
  hosted: HostedCall;
  dispatch: typeof dispatchTool;
  print: (text: string) => void;
  printError: (text: string) => void;
  /** Saves generated files (`--out`, else the project's asset folder). Default: a new FileSaver per run. */
  files?: FileSaver;
}

export const defaultOpsCliDeps: OpsCliDeps = {
  hosted: (name, args) => callHostedV4(name, args),
  dispatch: dispatchTool,
  print: (text) => process.stdout.write(`${text}\n`),
  printError: (text) => process.stderr.write(`${text}\n`),
};

/** The docs.read id of a local tool's guide (tool/<slug>). */
function guideOf(toolName: string): string | undefined {
  const entry = loadLibraryIndex().find((candidate) => candidate.kind === "tool" && candidate.mcp_tool_name === toolName);
  return entry?.id;
}

async function runLocal(op: string, call: ParsedCall, deps: OpsCliDeps): Promise<Answer> {
  // A split operation runs its 3.x tool with the action fixed (core/ops/engine.ts).
  const split = ENGINE_SPLIT_OPS[op];
  const entry = localEntries().find((candidate) => candidate.name === op);
  const tool = split?.tool ?? entry?.mcpTool ?? localToolsFor(op)[0];
  if (!tool) {
    const [area] = op.split(".");
    const closest = closestActions(op).map((action) => `summer ${area} ${action}`);
    const hint = closest.length ? ` Closest: ${closest.join(", ")}. All of them: summer ${area} --help` : "";
    return errorAnswer("not_found", `No operation is named "${op}".${hint}`, { next: { op: "ops.search", input: { query: op } } });
  }
  // maxCharacters cuts the text an MCP client gets; the CLI prints the whole answer.
  const { maxCharacters, ...input } = call.input;
  const uncut = maxCharacters === undefined ? undefined : ["maxCharacters: the CLI prints the whole answer; cut it in the shell (for example | head -c 8000)."];
  const args = split ? splitToolArgs(split, input) : input;
  const def = engineOpDef(op);
  const guide = guideOf(tool);
  const describe = guide && def ? { op: "docs.read", input: { id: guide } } : { op: "ops.describe", input: { name: op } };
  const missing = missingInput(localInputSchema(op), input);
  if (missing) return errorAnswer("invalid_input", missing, { next: describe });
  if (call.dryRun) {
    return { ok: true, status: "dry_run", preview: { summary: `${entry?.title ?? op}: the input is valid. Nothing was done.`, changes: [], approval: entry?.approval ?? "none", estimate: null, valid: true } };
  }
  try {
    return { ok: true, status: "done", result: await deps.dispatch(tool, args), ...(uncut ? { warnings: uncut } : {}) };
  } catch (error) {
    if (error instanceof EngineUnavailableError) return engineNotRunning();
    if (error instanceof ToolResultError) {
      if (def) return engineFailure(JSON.stringify(error.result), op, { effect: def.effect, guide });
      return codedLocalFailure(error.result) ?? errorAnswer("invalid_input", error.message, { details: { tool: error.result } });
    }
    return errorAnswer("invalid_input", error instanceof Error ? error.message : String(error), { next: describe });
  }
}

async function runCloud(op: string, call: ParsedCall, deps: OpsCliDeps): Promise<Answer> {
  try {
    return answerOfHosted(
      await deps.hosted("summer_call", { op, input: call.input, ...(call.dryRun ? { dryRun: true } : {}), ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}) })
    );
  } catch (error) {
    return hostedCallFailure(error, { op, dryRun: call.dryRun, idempotencyKey: call.idempotencyKey });
  }
}

/** The input schema used to type flags: the local descriptor, or the hosted ops.describe. */
async function schemaFor(op: string, deps: OpsCliDeps): Promise<JsonSchema | null> {
  if (isLocalOp(op)) return localInputSchema(op);
  const answer = await runCloud("ops.describe", { input: { name: op }, json: true, dryRun: false, wait: false }, deps);
  const input = answer.ok && answer.status === "done" ? (answer.result as { operation?: { input?: JsonSchema } }).operation?.input : undefined;
  return input ? (withOutField(op, input) as JsonSchema) : null;
}

/** Failed waits the job itself does not cause: the call to Summer did not get through. */
const WAIT_DID_NOT_GET_THROUGH: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["unavailable", "outcome_unknown", "not_signed_in", "forbidden", "rate_limited"]);

/** Follow a running job or an approval until it ends (jobs.wait, at most 50 s per call). */
async function waitFor(answer: Answer, deps: OpsCliDeps): Promise<Answer> {
  let current = answer;
  if (current.ok && current.status === "needs_approval") deps.printError(`Waiting for approval: ${current.approval.url}`);
  for (let round = 0; round < 120 && current.ok && (current.status === "running" || current.status === "needs_approval"); round++) {
    const job = current.job.id;
    const waited = await runCloud("jobs.wait", { input: { jobId: job, timeoutSeconds: 50 }, json: true, dryRun: false, wait: false }, deps);
    // The job runs on whatever the wait answered: a failed wait names it, so the job is waited on, not started again.
    // One that did not get through says to wait again; any other keeps its own next step (sign in, slow down).
    if (!waited.ok && WAIT_DID_NOT_GET_THROUGH.has(waited.error.code)) {
      const { code, message, retry, next, details } = waited.error;
      return errorAnswer(code, `${message} Job ${job} is still on Summer's server.`, {
        retry,
        next: code === "unavailable" ? { op: "jobs.wait", input: { jobId: job } } : next,
        details: { ...details, job },
      });
    }
    if (!waited.ok || waited.status !== "done") return waited;
    const result = waited.result as { job: { state: string; result?: unknown; error?: { code: string; message: string } }; finished: boolean };
    if (!result.finished) continue;
    // An approved generation runs on as its own job: follow that job.
    const chained = result.job.result as { status?: string; job?: JobRef } | undefined;
    if (result.job.state === "done" && chained?.status === "running" && chained.job?.id) {
      current = { ok: true, status: "running", job: chained.job };
      continue;
    }
    if (result.job.state === "done") return { ok: true, status: "done", result: result.job.result ?? {} };
    return errorAnswer(result.job.state === "failed" ? "invalid_input" : "conflict", result.job.error?.message ?? `The job ended: ${result.job.state}.`, { details: { job } });
  }
  return current;
}

/** A value as one shell word: single quotes, so the shell expands nothing in it. */
const shellWord = (value: string) => (/^[\w./:@+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** The answer for a person; `out` is the --out to keep in the printed wait command. */
/** A failure's problem list (a manifest's fields), one per line: in the answer's details or its tool's structured result. */
function problemLines(details: Record<string, unknown> | undefined): string {
  const tool = details?.tool && typeof details.tool === "object" ? (details.tool as Record<string, unknown>) : undefined;
  const problems = Array.isArray(details?.problems) ? details.problems : Array.isArray(tool?.problems) ? tool.problems : [];
  const lines = problems.filter((problem): problem is string => typeof problem === "string");
  return lines.length ? `\n${lines.map((problem) => `  - ${problem}`).join("\n")}` : "";
}

export function formatAnswer(answer: Answer, out?: string): string {
  const waitFlags = (id: string) => `summer jobs wait --job-id ${id}${out ? ` --out ${shellWord(out)}` : ""}`;
  if (!answer.ok) {
    const next = answer.error.next;
    const step = !next ? "" : "op" in next ? `\nNext: ${next.op}` : "url" in next ? `\nNext: ${next.label}: ${next.url}` : `\nNext: ${next.say}`;
    return `Error (${answer.error.code}): ${answer.error.message}${problemLines(answer.error.details)}${step}`;
  }
  switch (answer.status) {
    case "done":
      return JSON.stringify(answer.result, null, 2);
    case "running":
      return `Started: job ${answer.job.id}. Wait for it: ${waitFlags(answer.job.id)}`;
    case "needs_approval":
      return `Needs approval (${answer.approval.who}): ${answer.approval.summary}\n${answer.approval.url}\nNothing changes until they approve. Follow it: ${waitFlags(answer.job.id)}`;
    case "dry_run":
      return `Dry run: ${String(answer.preview.summary ?? "")}\n${JSON.stringify(answer.preview, null, 2)}`;
  }
}

/** Run one operation from the command line and print its answer; returns the exit code. */
export async function runOpFromCli(op: string, argv: readonly string[], deps: OpsCliDeps = defaultOpsCliDeps): Promise<number> {
  if (!OP_NAME.test(op)) {
    deps.printError(formatAnswer(errorAnswer("invalid_input", `"${op}" is not an operation name (area action).`, { next: { op: "ops.search" } })));
    return 1;
  }
  let call: ParsedCall;
  try {
    const hasFields = argv.some((token) => token.startsWith("--") && !RESERVED_FLAGS.has(token.slice(2).split("=")[0]));
    call = parseCallFlags(argv, hasFields ? await schemaFor(op, deps) : null);
  } catch (error) {
    deps.printError(formatAnswer(errorAnswer("invalid_input", error instanceof Error ? error.message : String(error))));
    return 1;
  }
  let answer: Answer;
  let out: string | undefined;
  if (isLocalOp(op)) {
    answer = await runLocal(op, call, deps);
    if (call.wait) answer = await waitFor(answer, deps);
  } else {
    // Summer's server records a cloud operation itself (X-Summer-Client-Surface: cli).
    noteCliHosted();
    // --out stays here: the files save on this machine once the answer (or the waited job) names them.
    const files = deps.files ?? new FileSaver({ saveByDefault: true });
    const taken = files.take(op, call.input);
    out = taken.out;
    answer = await runCloud(op, { ...call, input: taken.input }, deps);
    if (call.wait) answer = await waitFor(answer, deps);
    answer = await files.finish(op, answer, out);
  }
  if (!answer.ok) noteCliError(answer.error.code);
  (answer.ok ? deps.print : deps.printError)(call.json ? JSON.stringify(answer) : formatAnswer(answer, out));
  if (!call.json && answer.ok) for (const warning of answer.warnings ?? []) deps.printError(`Warning: ${warning}`);
  return answer.ok ? 0 : 1;
}

/**
 * `summer ops search <words...>`: every operation, local and cloud, signed in
 * or not; a cloud one that needs a sign-in says so. A how-to (docs.search
 * first) points at the library.
 */
export async function searchFromCli(query: string, options: { area?: string; limit: number; json: boolean }, deps: OpsCliDeps = defaultOpsCliDeps): Promise<void> {
  const { items, warning } = await searchEverywhere(query, { area: options.area, limit: options.limit }, deps.hosted);
  if (options.json) {
    deps.print(JSON.stringify({ ok: true, status: "done", result: { items }, ...(warning ? { warnings: [warning] } : {}) }));
    return;
  }
  for (const item of items) deps.print(`${item.name.padEnd(32)} ${item.effect.padEnd(13)} ${item.title}${item.needsSignIn ? "  (needs sign-in)" : ""}`);
  if (items[0]?.name === "docs.search") deps.print(`How-to guides for this: summer docs search --query ${shellWord(query)}`);
  if (warning) deps.printError(warning);
}

/**
 * `summer ops describe <op>`: a local operation from this package; a cloud
 * one from Summer's server, or from the shipped catalog when the server
 * cannot answer (signed out, offline).
 */
export async function describeFromCli(
  op: string,
  deps: OpsCliDeps = defaultOpsCliDeps,
  options: { json?: boolean } = {}
): Promise<number> {
  const local = localWireForm(resolveOpName(op));
  if (local) {
    // --json: the same answer shape as the cloud describe ({operation}).
    deps.print(options.json ? JSON.stringify({ ok: true, status: "done", result: { operation: local } }) : JSON.stringify(local, null, 2));
    return 0;
  }
  const asked = await runCloud("ops.describe", { input: { name: op }, json: options.json === true, dryRun: false, wait: false }, deps);
  const answer = describeFromShipped(op, asked) ?? asked;
  (answer.ok ? deps.print : deps.printError)(options.json ? JSON.stringify(answer) : formatAnswer(answer));
  if (!options.json && answer.ok) for (const warning of answer.warnings ?? []) deps.printError(`Warning: ${warning}`);
  return answer.ok ? 0 : 1;
}

const HELP_WORDS: ReadonlySet<string> = new Set(["--help", "-h", "help"]);
/** gameId -> game-id, look_at -> look-at: the flag a field takes. */
const flagOf = (field: string) => field.replace(/_/g, "-").replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const VIEW_FLAGS = "[--input '<json>'] [--dry-run] [--wait] [--json]";

/** `summer <area> --help`: the area's actions, from this package and the shipped catalog (no network). */
export function areaHelp(area: string): string {
  const titles = new Map<string, string>();
  for (const entry of [...localEntries(), ...shippedCloudEntries()]) {
    if (entry.name.startsWith(`${area}.`) && !titles.has(entry.name)) titles.set(entry.name, entry.title);
  }
  const actions = [...titles].map(([name, title]) => [flagOf(name.slice(area.length + 1)), title] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const width = Math.max(0, ...actions.map(([action]) => action.length));
  return [
    `Usage: summer ${area} <action> [--<field> <value> ...] ${VIEW_FLAGS}`,
    "",
    ...(actions.length ? ["Actions:", ...actions.map(([action, title]) => `  ${action.padEnd(width)}  ${title}`)] : [`This version lists no ${area} operations; signed in, summer ops search ${area} finds the server's.`]),
    "",
    `One action's fields: summer ${area} <action> --help`,
  ].join("\n");
}

type WireOperation = { name: string; title?: string; summary?: string; effect?: string; approval?: string; auth?: string; input?: JsonSchema & { required?: string[] } };

/** One operation's help: its command, what it does, who approves, the sign-in and each field as a flag. */
export function operationHelp(operation: WireOperation): string {
  const [area, action] = operation.name.split(".");
  const command = action ? `summer ${area} ${flagOf(action)}` : `summer ${area}`;
  const required = new Set(operation.input?.required ?? []);
  const fields = Object.entries(operation.input?.properties ?? {}).map(([field, schema]) => {
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    const flag = `--${flagOf(field)}${type === "boolean" ? "" : ` <${type ?? "value"}>`}`;
    const description = (schema as { description?: string }).description ?? "";
    return [flag, `${required.has(field) ? "Required. " : ""}${description}`.trim()] as const;
  });
  const width = Math.max(0, ...fields.map(([flag]) => flag.length));
  const signIn = operation.auth === "account" ? "Needs a sign-in: summer login (the store sign-in alone: summer login --store)." : "Works signed out.";
  return [
    `Usage: ${command} ${fields.length ? "[--<field> <value> ...] " : ""}${VIEW_FLAGS}`,
    "",
    `${operation.title ?? operation.name}${operation.summary ? `: ${operation.summary}` : ""}`,
    `Effect: ${operation.effect ?? "unknown"}. Approval: ${operation.approval ?? "none"}. ${signIn}`,
    ...(fields.length ? ["", "Fields:", ...fields.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`)] : []),
    "",
    `The exact input: summer ops describe ${operation.name}`,
  ].join("\n");
}

/** `summer <area> <action> --help`: from this package or the shipped catalog; the server only for an operation newer than both. */
export async function operationHelpFromCli(op: string, deps: OpsCliDeps = defaultOpsCliDeps): Promise<number> {
  const name = resolveOpName(op);
  let operation = (localWireForm(name) ?? shippedWireForm(name)) as WireOperation | null;
  if (!operation) {
    const asked = await runCloud("ops.describe", { input: { name }, json: true, dryRun: false, wait: false }, deps);
    if (!asked.ok || asked.status !== "done") {
      deps.printError(formatAnswer(asked));
      return 1;
    }
    operation = (asked.result as { operation?: WireOperation }).operation ?? null;
    if (!operation) {
      deps.printError(formatAnswer(errorAnswer("not_found", `No operation is named "${name}".`, { next: { op: "ops.search", input: { query: name } } })));
      return 1;
    }
  }
  deps.print(operationHelp(operation));
  return 0;
}

function areaCommand(area: string): Command {
  return new Command(area)
    .description(`Summer ${area} operations: summer ${area} <action> --field value. Find them: summer ops search ${area}`)
    .argument("[action]", "The operation's action, e.g. list or set-base")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .action(async (action: string | undefined, _options: unknown, command: Command) => {
      // Our own help: commander's would list no actions and no fields.
      if (action === undefined || HELP_WORDS.has(action)) {
        (action === undefined ? defaultOpsCliDeps.printError : defaultOpsCliDeps.print)(areaHelp(area));
        process.exitCode = action === undefined ? 1 : 0;
        return;
      }
      const argv = command.args.slice(1);
      // A 3.x tool name as the action runs its operation (resolveCliOp).
      const op = resolveCliOp(area, action);
      process.exitCode = argv.some((token) => HELP_WORDS.has(token) && token !== "help")
        ? await operationHelpFromCli(op)
        : await runOpFromCli(op, argv);
    });
}

export function opsCliCommands(): Command[] {
  const whoami = new Command("whoami")
    .description("Who is signed in, and their credits")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (_options: unknown, command: Command) => {
      process.exitCode = await runOpFromCli("whoami", command.args);
    });

  const ops = new Command("ops").description("Find and describe Summer operations");
  ops
    .command("search <words...>")
    .description("Find operations by describing the job in plain words")
    .option("--area <area>", "Only this area")
    .option("--limit <n>", "Most results", "8")
    .option("--json", "Print the answer as JSON")
    .action(async (wordsArg: string[], options: { area?: string; limit: string; json?: boolean }) => {
      await searchFromCli(wordsArg.join(" "), { area: options.area, limit: Number(options.limit) || 8, json: options.json === true });
    });
  ops
    .command("describe <op>")
    .description("Show one operation with its exact input")
    .option("--json", "Print the answer as JSON")
    .action(async (op: string, options: { json?: boolean }) => {
      process.exitCode = await describeFromCli(op, defaultOpsCliDeps, { json: options.json === true });
    });

  return [whoami, ops, ...CLI_AREAS.map(areaCommand)];
}
