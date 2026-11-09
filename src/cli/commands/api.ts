import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  API_NOT_OPEN,
  SummerApiError,
  cancelJob,
  createBatch,
  downloadBatchFiles,
  downloadJobFiles,
  estimateJob,
  getJob,
  isFinished,
  listModels,
  isBatchFinished,
  parseBatchLines,
  runJob,
  waitForBatch,
  waitForJob,
  type Batch,
  type Job,
  type SummerApiDependencies,
} from "../../core/summer-api.js";

/**
 * `summer api models|estimate|run|jobs`: the Summer API (core/summer-api.ts)
 * from a shell. JSON when stdout is not a terminal (or with --json); a short
 * summary for people. `--wait` follows a job until it finishes; `--download
 * [dir]` also saves its files. `run --batch file.jsonl` queues up to 500
 * jobs at once (all or none). While Summer has not opened the API, every
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

/** A text file as any system writes it: UTF-8 with or without a BOM, or UTF-16 (Windows PowerShell 5's > and Out-File). */
export async function readTextFile(file: string): Promise<string> {
  const bytes = await readFile(file);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  return bytes.toString("utf8").replace(/^\uFEFF/, "");
}

/**
 * --input: a JSON object, or "@file" with one. Windows PowerShell 5 strips the
 * inner quotes of '{"prompt":"..."}' before the CLI sees them, and cmd.exe has
 * no single quotes, so a file is the dependable way there (quoted: PowerShell
 * reads a bare @ as splatting).
 */
export async function parseInput(text: string | undefined): Promise<Record<string, unknown>> {
  if (!text) return {};
  if (text.startsWith("@")) {
    try {
      text = await readTextFile(text.slice(1));
    } catch {
      throw new SummerApiError("invalid_input", `Cannot read the input file ${text.slice(1)}.`, 400);
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SummerApiError("invalid_input", "--input must be a JSON object, e.g. --input '{\"prompt\":\"a wooden chest\"}', or a file with one: --input \"@input.json\" (in Windows PowerShell and cmd).", 400);
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
    // A refused batch's details say how many jobs fit and how much more is needed.
    const details = error instanceof SummerApiError && error.body?.details && typeof error.body.details === "object" ? error.body.details : undefined;
    if (json) io.print(JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } }));
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

function batchSummary(batch: Batch, files: Record<string, string[]> = {}): string[] {
  const counts = Object.entries(batch.counts ?? {}).map(([state, count]) => `${count} ${state}`).join(", ");
  const lines = [`Batch ${batch.id}: ${batch.jobs.length} jobs${typeof batch.estimatedPrice === "string" ? ` (estimated ${batch.estimatedPrice} USD)` : ""}${counts ? `, ${counts}` : ""}`];
  for (const job of batch.jobs) {
    lines.push(`  ${job.id}: ${job.state}${typeof job.model === "string" ? ` ${job.model}` : ""}`);
    for (const file of files[job.id] ?? []) lines.push(`    saved ${file}`);
  }
  if (!isBatchFinished(batch)) lines.push(`  Follow a job: summer api jobs <id> --wait`);
  return lines;
}

/** run --batch: queue every line of the file as one batch, then --wait and --download as for one job. */
export async function runBatch(
  file: string,
  opts: { idempotencyKey?: string; wait?: boolean; download?: string | boolean },
  overrides: Partial<SummerApiDependencies> = {}
): Promise<{ data: unknown; summary: string[] }> {
  let text: string;
  try {
    text = await readTextFile(file);
  } catch {
    throw new SummerApiError("invalid_input", `Cannot read the batch file ${file}.`, 400);
  }
  const batch = await createBatch(parseBatchLines(text), opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}, overrides);
  const follow = opts.wait === true || opts.download !== undefined;
  const final = follow && !isBatchFinished(batch) ? await waitForBatch(batch, {}, overrides) : batch;
  const files = opts.download !== undefined ? await downloadBatchFiles(final, typeof opts.download === "string" ? opts.download : ".", overrides) : undefined;
  return { data: { batch: final, ...(files ? { files } : {}) }, summary: batchSummary(final, files) };
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
  .option("--input <json>", "The model's input as a JSON object, or @file.json (summer api models <model> shows its schema)")
  .option("--json", "JSON (the default when stdout is not a terminal)")
  .action(async (model: string, opts: { input?: string } & JsonOption) =>
    exit(
      await runApiAction(opts, async () => {
        const data = await estimateJob(model, await parseInput(opts.input));
        return { data, summary: [`${data.model ?? model}: ${data.atMost ? "at most " : ""}${data.price} ${data.currency ?? "USD"}${data.quoteId ? `  quote ${data.quoteId}` : ""}`] };
      })
    )
  );

const runSubcommand = new Command("run")
  .description("Run one job into your Summer assets, or a batch of up to 500 with --batch; spends your paid credits within this app's limit (Connected apps)")
  .argument("[model]", "A model id or alias, e.g. 3d/default (not with --batch)")
  .option("--input <json>", "The model's input as a JSON object, or @file.json")
  .option("--batch <file>", "A JSONL file, one job per line: {\"model\": ..., \"input\": {...}, \"idempotencyKey\": optional}; up to 500, all or none")
  .option("--quote <quoteId>", "From summer api estimate: refuse to charge more than it quoted")
  .option("--idempotency-key <key>", "Reuse to retry the same run or batch without running it twice (default: a new one)")
  .option("--wait", "Follow the job (or every job of the batch) until it finishes")
  .option("--download [dir]", "Follow it and save its files (default: this folder)")
  .option("--json", "JSON (the default when stdout is not a terminal)")
  .action(async (model: string | undefined, opts: { input?: string; batch?: string; quote?: string; idempotencyKey?: string; wait?: boolean; download?: string | boolean } & JsonOption) =>
    exit(
      await runApiAction(opts, async () => {
        if (opts.batch) {
          if (model || opts.input || opts.quote) throw new SummerApiError("invalid_input", "--batch takes the model and input from each line of its file; leave out <model>, --input and --quote.", 400);
          return runBatch(opts.batch, opts);
        }
        if (!model) throw new SummerApiError("invalid_input", "Name a model (summer api run 3d/default --input '{...}'), or pass --batch file.jsonl.", 400);
        const follow = opts.wait === true || opts.download !== undefined;
        const job = await runJob(model, await parseInput(opts.input), {
          ...(opts.quote ? { quoteId: opts.quote } : {}),
          ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
          ...(follow ? { waitSeconds: 60 } : {}),
        });
        return finish(job, opts);
      })
    )
  );

const jobsCommand = new Command("jobs")
  .description("Read a job; --wait follows it, --download saves its files")
  .argument("<jobId>", "The job id summer api run answered")
  .option("--wait", "Follow the job until it finishes")
  .option("--download [dir]", "Follow it and save its files (default: this folder)")
  .option("--cancel", "Ask to stop the job (Summer API jobs, queued or running, run to the end: the answer is unsupported)")
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
