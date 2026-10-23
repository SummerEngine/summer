import { Command } from "commander";
import {
  API_NOT_OPEN,
  SummerApiError,
  cancelJob,
  downloadJobFiles,
  estimateJob,
  getJob,
  isFinished,
  listModels,
  runJob,
  waitForJob,
  type Job,
} from "../../core/summer-api.js";

/**
 * `summer api models|estimate|run|jobs`: the Summer API (core/summer-api.ts)
 * from a shell. JSON when stdout is not a terminal (or with --json); a short
 * summary for people. `--wait` follows a job until it finishes; `--download
 * [dir]` also saves its files. While Summer has not opened the API, every
 * command prints one line, "Summer API is not open yet.", and exits 1.
 */

export interface ApiCommandIo {
  isTTY: boolean;
  print: (line: string) => void;
  printError: (line: string) => void;
}

const defaultIo = (): ApiCommandIo => ({
  isTTY: process.stdout.isTTY === true,
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
});

type JsonOption = { json?: boolean };

function parseInput(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SummerApiError("invalid_input", "--input must be a JSON object, e.g. --input '{\"prompt\":\"a wooden chest\"}'.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SummerApiError("invalid_input", "--input must be a JSON object.", 400);
  return value as Record<string, unknown>;
}

/** Run one api command: its answer as JSON or as the summary, its errors as one line (or one JSON object). */
export async function runApiAction(
  opts: JsonOption,
  work: () => Promise<{ data: unknown; summary: string[] }>,
  io: ApiCommandIo = defaultIo()
): Promise<number> {
  const json = opts.json === true || !io.isTTY;
  try {
    const { data, summary } = await work();
    if (json) io.print(JSON.stringify(data, null, 2));
    else for (const line of summary) io.print(line);
    return 0;
  } catch (error) {
    if (error instanceof SummerApiError && error.code === "api_not_open") {
      io.printError(API_NOT_OPEN);
      return 1;
    }
    const code = error instanceof SummerApiError ? error.code : "request_failed";
    const message = error instanceof Error ? error.message : String(error);
    if (json) io.print(JSON.stringify({ ok: false, error: { code, message } }));
    else io.printError(message);
    return 1;
  }
}

function jobSummary(job: Job, files: string[] = []): string[] {
  const lines = [`Job ${job.id}: ${job.state}${typeof job.price === "string" ? ` (${job.price} USD)` : typeof job.estimatedPrice === "string" ? ` (estimated ${job.estimatedPrice} USD)` : ""}`];
  const result = (job.result && typeof job.result === "object" ? job.result : {}) as Record<string, unknown>;
  for (const asset of (Array.isArray(result.assets) ? result.assets : []) as Array<Record<string, unknown>>) {
    lines.push(`  ${asset.assetId ?? "asset"}: ${asset.fileUrl ?? ""}`);
  }
  for (const file of files) lines.push(`  saved ${file}`);
  if (!isFinished(job)) lines.push(`  Follow it: summer api jobs ${job.id} --wait`);
  return lines;
}

/** --wait and --download for a job that came back: follow it, then save its files. */
async function finish(job: Job, opts: { wait?: boolean; download?: string | boolean }): Promise<{ data: unknown; summary: string[] }> {
  const follow = opts.wait === true || opts.download !== undefined;
  const final = follow && !isFinished(job) ? await waitForJob(job) : job;
  const dir = typeof opts.download === "string" ? opts.download : ".";
  const files = opts.download !== undefined && final.state === "done" ? await downloadJobFiles(final, dir) : [];
  return { data: { job: final, ...(opts.download !== undefined ? { files } : {}) }, summary: jobSummary(final, files) };
}

const exit = (code: number) => {
  if (code) process.exitCode = code;
};

const modelsCommand = new Command("models")
  .description("The Summer API's curated game-dev models, with input and price; one model with its id (no sign-in needed)")
  .argument("[model]", "A model id or alias, e.g. 3d/default")
  .option("--capability <capability>", "Only one kind: image, 3d, video, voice, dialogue, sound or music")
  .option("--json", "JSON (the default when stdout is not a terminal)")
  .action(async (model: string | undefined, opts: { capability?: string } & JsonOption) =>
    exit(
      await runApiAction(opts, async () => {
        const data = await listModels({ ...(model ? { model } : {}), ...(opts.capability ? { capability: opts.capability } : {}) });
        const models = (Array.isArray(data.models) ? data.models : data.model ? [data.model] : []) as Array<Record<string, unknown>>;
        const price = (entry: Record<string, unknown>) => {
          const p = (entry.price && typeof entry.price === "object" ? entry.price : {}) as Record<string, unknown>;
          return typeof p.price === "string" ? `${p.price} USD${typeof p.unit === "string" ? ` per ${p.unit}` : ""}` : "";
        };
        return { data, summary: models.map((entry) => `${String(entry.id).padEnd(28)} ${String(entry.capability ?? "").padEnd(9)} ${price(entry)}`) };
      })
    )
  );

const estimateCommand = new Command("estimate")
  .description("The exact price of one job before it runs, and a quote id that holds it for 15 minutes; charges nothing")
  .argument("<model>", "A model id or alias, e.g. 3d/default")
  .option("--input <json>", "The model's input as a JSON object (summer api models <model> shows its schema)")
  .option("--json", "JSON (the default when stdout is not a terminal)")
  .action(async (model: string, opts: { input?: string } & JsonOption) =>
    exit(
      await runApiAction(opts, async () => {
        const data = await estimateJob(model, parseInput(opts.input));
        return { data, summary: [`${data.model ?? model}: ${data.atMost ? "at most " : ""}${data.price} ${data.currency ?? "USD"}${data.quoteId ? `  quote ${data.quoteId}` : ""}`] };
      })
    )
  );

const runSubcommand = new Command("run")
  .description("Run one job into your Summer assets; spends your paid credits within this app's limit (Connected apps)")
  .argument("<model>", "A model id or alias, e.g. 3d/default")
  .option("--input <json>", "The model's input as a JSON object")
  .option("--quote <quoteId>", "From summer api estimate: refuse to charge more than it quoted")
  .option("--idempotency-key <key>", "Reuse to retry the same run without running it twice (default: a new one)")
  .option("--wait", "Follow the job until it finishes")
  .option("--download [dir]", "Follow it and save its files (default: this folder)")
  .option("--json", "JSON (the default when stdout is not a terminal)")
  .action(async (model: string, opts: { input?: string; quote?: string; idempotencyKey?: string; wait?: boolean; download?: string | boolean } & JsonOption) =>
    exit(
      await runApiAction(opts, async () => {
        const follow = opts.wait === true || opts.download !== undefined;
        const job = await runJob(model, parseInput(opts.input), {
          ...(opts.quote ? { quoteId: opts.quote } : {}),
          ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
          ...(follow ? { waitSeconds: 60 } : {}),
        });
        return finish(job, opts);
      })
    )
  );

const jobsCommand = new Command("jobs")
  .description("Read a job; --wait follows it, --download saves its files, --cancel stops it")
  .argument("<jobId>", "The job id summer api run answered")
  .option("--wait", "Follow the job until it finishes")
  .option("--download [dir]", "Follow it and save its files (default: this folder)")
  .option("--cancel", "Cancel the job")
  .option("--json", "JSON (the default when stdout is not a terminal)")
  .action(async (jobId: string, opts: { wait?: boolean; download?: string | boolean; cancel?: boolean } & JsonOption) =>
    exit(
      await runApiAction(opts, async () => {
        if (opts.cancel) {
          const job = await cancelJob(jobId);
          return { data: { job }, summary: jobSummary(job) };
        }
        return finish(await getJob(jobId), opts);
      })
    )
  );

export const apiCommand = new Command("api")
  .description("The Summer API: game-dev models, prices, estimates and jobs, with this computer's Summer sign-in (summer login)")
  .addCommand(modelsCommand)
  .addCommand(estimateCommand)
  .addCommand(runSubcommand)
  .addCommand(jobsCommand);
