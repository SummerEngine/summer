/**
 * summer_api_models, summer_api_estimate, summer_api_run, summer_api_batch,
 * summer_api_job — the Summer API (core/summer-api.ts), the same calls as
 * `summer api models|estimate|run|run --batch|jobs`. MCP adapter only: schemas and descriptions here.
 * Runs and jobs use the Summer sign-in on this computer (summer login: Supabase OAuth, refreshed by itself).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  batchToolResult,
  cancelJob,
  checkBatch,
  createBatch,
  estimateJob,
  getBatch,
  getJob,
  jobToolResult,
  listModels,
  runJob,
  summerApiToolAnswer,
} from "../../core/summer-api.js";
import { textJson } from "./text-json.js";

const modelId = z.string().min(1).max(120).describe("A Summer API model id or alias from summer_api_models, e.g. 3d/default.");
const modelInput = z.record(z.string(), z.unknown()).optional().describe("The model's input, matching its inputSchema from summer_api_models.");
const out = z.string().min(1).optional().describe("A folder on this computer: save the finished job's files there (implies wait).");

export const apiModelsInputShape = {
  model: modelId.optional().describe("One model id or alias; without it, every model."),
  capability: z.enum(["image", "3d", "video", "voice", "dialogue", "sound", "music"]).optional().describe("Only this kind."),
};
export const apiEstimateInputShape = { model: modelId, input: modelInput };
export const apiRunInputShape = {
  model: modelId,
  input: modelInput,
  quoteId: z.string().min(1).max(600).optional().describe("From summer_api_estimate: refuse to charge more than it quoted."),
  idempotencyKey: z.string().min(1).max(200).optional().describe("Reuse to retry the same run without running it twice."),
  wait: z.boolean().optional().describe("Follow the job until it finishes (up to about a minute in this call)."),
  out,
};
export const apiBatchInputShape = {
  jobs: z
    .array(
      z.object({
        model: modelId,
        input: modelInput,
        idempotencyKey: z.string().min(1).max(200).optional().describe("This job's own key; by default the batch key and the job's position."),
      })
    )
    .min(1)
    .max(500)
    .optional()
    .describe("Up to 500 jobs, all or none. Leave out with batchId."),
  batchId: z.string().min(1).max(200).optional().describe("Read a batch summer_api_batch answered, instead of starting one."),
  idempotencyKey: z.string().min(1).max(200).optional().describe("Reuse to retry the same batch without queuing it twice."),
  wait: z.boolean().optional().describe("Follow every job until it finishes (up to about a minute in this call)."),
  out,
};
export const apiJobInputShape = {
  jobId: z.string().min(1).max(200).describe("The job id summer_api_run answered."),
  wait: z.boolean().optional().describe("Follow the job until it finishes (up to about a minute in this call)."),
  out,
  cancel: z.boolean().optional().describe("Ask to stop the job instead. Summer API jobs, queued or running, run to the end: the answer is unsupported."),
};

const answer = async (work: () => Promise<Record<string, unknown>>) => {
  const result = await summerApiToolAnswer(work);
  return textJson(result, result.ok === false);
};

export function registerApiTools(server: McpServer): void {
  server.tool(
    "summer_api_models",
    "The Summer API's curated game-dev models: id, capability, input schema, output formats, typical time and price in USD. No sign-in needed. Next: summer_api_estimate for one exact request.",
    apiModelsInputShape,
    async (args: { model?: string; capability?: string }) => answer(() => listModels(args))
  );
  server.tool(
    "summer_api_estimate",
    "The exact USD price of one Summer API job before it runs, what makes it up, and a quoteId that holds the price for 15 minutes. Charges nothing; no sign-in needed. Next: summer_api_run with the quoteId.",
    apiEstimateInputShape,
    async (args: { model: string; input?: Record<string, unknown> }) => answer(() => estimateJob(args.model, args.input ?? {}))
  );
  server.tool(
    "summer_api_run",
    "Run one Summer API job into the person's Summer assets with the Summer sign-in on this computer (the person runs summer login first). Spends their paid credits within this app's limit (Connected apps): say what you will make and estimate it first. Short jobs come back done; past the account's running slots a job answers queued at a held price and starts in order. wait follows it, out saves its files on this computer. no_credits (the paid balance) or over_limit (this app's limit): show the person the message and its link.",
    apiRunInputShape,
    async (args: { model: string; input?: Record<string, unknown>; quoteId?: string; idempotencyKey?: string; wait?: boolean; out?: string }) =>
      answer(async () => {
        const follow = args.wait === true || typeof args.out === "string";
        const job = await runJob(args.model, args.input ?? {}, {
          ...(args.quoteId ? { quoteId: args.quoteId } : {}),
          ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
          ...(follow ? { waitSeconds: 30 } : {}),
        });
        return jobToolResult(job, args);
      })
  );
  server.tool(
    "summer_api_batch",
    "Run up to 500 Summer API jobs at once with the Summer sign-in on this computer, all or none: when the person's paid credits and this app's limit (Connected apps) cover every job, all are queued at their held prices and run in order; if not, nothing runs and the error (no_credits or over_limit) says how many fit and how much more is needed (show the person its link). Say what you will make and what it costs first. batchId reads a batch; wait follows it, out saves the finished files on this computer.",
    apiBatchInputShape,
    async (args: { jobs?: Array<{ model: string; input?: Record<string, unknown>; idempotencyKey?: string }>; batchId?: string; idempotencyKey?: string; wait?: boolean; out?: string }) =>
      answer(async () => {
        if (args.batchId) return batchToolResult(await getBatch(args.batchId), args);
        const batch = await createBatch(checkBatch(args.jobs ?? []), args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {});
        return batchToolResult(batch, args);
      })
  );
  server.tool(
    "summer_api_job",
    "Read a Summer API job: its state (queued, running, done, failed, ...), price and, when done, its assets and Summer file URLs. wait follows it, out saves its files on this computer.",
    apiJobInputShape,
    async (args: { jobId: string; wait?: boolean; out?: string; cancel?: boolean }) =>
      answer(async () => (args.cancel ? { job: await cancelJob(args.jobId) } : jobToolResult(await getJob(args.jobId), args)))
  );
}
