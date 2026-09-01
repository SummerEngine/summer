import { Command } from "commander";
import { createDebugReportArtifact, redactDebugReport } from "../../core/capabilities/debug-report.js";
import { c, sym, tildeify } from "../../core/format.js";

interface DebugCommandOptions {
  output?: string;
  json?: boolean;
  play?: boolean;
  doctor?: boolean;
  maxConsoleLines?: string;
  maxDebuggerEntries?: string;
  playWaitMs?: string;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const debugCommand = new Command("debug")
  .description("Create a support-ready Markdown debug report")
  .argument("[issue...]", "What is broken or surprising?")
  .option("-o, --output <path>", "Write the report to this path")
  .option("--json", "Print JSON with the report path and collected data")
  .option("--play", "Also launch the game briefly and collect post-play diagnostics")
  .option("--no-doctor", "Skip summer doctor checks")
  .option("--max-console-lines <n>", "Console lines to collect", "200")
  .option("--max-debugger-entries <n>", "Debugger entries to collect", "100")
  .option("--play-wait-ms <n>", "Milliseconds to wait after --play starts", "2500")
  .action(async (issueParts: string[], opts: DebugCommandOptions) => {
    const issue = issueParts.join(" ").trim();
    const artifact = await createDebugReportArtifact({
      issue,
      outputPath: opts.output,
      includePlaySession: Boolean(opts.play),
      includeDoctor: opts.doctor !== false,
      maxConsoleLines: parsePositiveInt(opts.maxConsoleLines, 200),
      maxDebuggerEntries: parsePositiveInt(opts.maxDebuggerEntries, 100),
      playWaitMs: parsePositiveInt(opts.playWaitMs, 2500),
    });

    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        path: artifact.path,
        report: redactDebugReport(artifact.report),
      }, null, 2));
      return;
    }

    console.log("");
    console.log(`${sym.ok()} ${c.bold("Summer debug report created")}`);
    console.log(`   ${tildeify(artifact.path)}`);
    console.log("");
    console.log("Review it before sending. It omits auth tokens, but may include local paths and stack traces.");
  });
