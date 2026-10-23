/**
 * summer_api_models, summer_api_estimate, summer_api_run, summer_api_job — the
 * Summer API (core/summer-api.ts), the same calls as `summer api
 * models|estimate|run|jobs`. MCP adapter only: schemas and descriptions here.
 * Runs and jobs use the Summer API key on this computer (summer_api_key_login).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cancelJob,
  estimateJob,
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
export const apiJobInputShape = {
  jobId: z.string().min(1).max(200).describe("The job id summer_api_run answered."),
  wait: z.boolean().optional().describe("Follow the job until it finishes (up to about a minute in this call)."),
  out,
  cancel: z.boolean().optional().describe("Cancel the job instead."),
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
    "Run one Summer API job into the person's Summer assets with the Summer API key on this computer (summer_api_key_login first). Spends their credits within the key's limit: say what you will make and estimate it first. Short jobs come back done; wait follows a long one, out saves its files on this computer. key_limit_reached or insufficient_credits: give the person the link in the message.",
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
    "summer_api_job",
    "Read a Summer API job: its state, price and, when done, its assets and Summer file URLs. wait follows it, out saves its files on this computer, cancel stops it.",
    apiJobInputShape,
    async (args: { jobId: string; wait?: boolean; out?: string; cancel?: boolean }) =>
      answer(async () => (args.cancel ? { job: await cancelJob(args.jobId) } : jobToolResult(await getJob(args.jobId), args)))
  );
}
