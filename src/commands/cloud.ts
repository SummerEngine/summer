import { Command } from "commander";
import {
  cloudCheckpoints,
  cloudConflicts,
  cloudInit,
  cloudPull,
  cloudPush,
  cloudRestore,
  cloudStatus,
} from "../lib/cloud/sync.js";
import type { BootstrapChoice, SyncOptions, SyncResult } from "../lib/cloud/types.js";

export const cloudCommand = new Command("cloud").description("Sync Summer Engine projects with Summer Cloud");

cloudCommand
  .command("init")
  .description("Enable Summer Cloud for this project")
  .option("--project <path>", "Project root path")
  .option("--json", "Print JSON")
  .action(async (opts: SyncOptions) => printResult(await cloudInit(opts), opts.json));

cloudCommand
  .command("status")
  .description("Show Summer Cloud sync status")
  .option("--project <path>", "Project root path")
  .option("--json", "Print JSON")
  .action(async (opts: SyncOptions) => printResult(await cloudStatus(opts), opts.json));

cloudCommand
  .command("push")
  .description("Push local project changes to Summer Cloud")
  .option("--project <path>", "Project root path")
  .option("--json", "Print JSON")
  .option("--confirm-deletes", "Allow guarded cloud deletions")
  .option("--bootstrap <choice>", "No-base bootstrap choice: keep-cloud, keep-local, merge")
  .option("--adopt-path", "Accept that the project folder moved and update the recorded path")
  .action(async (opts: SyncOptions & { bootstrap?: BootstrapChoice }) => printResult(await cloudPush(opts), opts.json));

cloudCommand
  .command("pull")
  .description("Pull Summer Cloud changes into this project")
  .option("--project <path>", "Project root path")
  .option("--json", "Print JSON")
  .option("--bootstrap <choice>", "No-base bootstrap choice: keep-cloud, keep-local, merge")
  .option("--adopt-path", "Accept that the project folder moved and update the recorded path")
  .action(async (opts: SyncOptions & { bootstrap?: BootstrapChoice }) => printResult(await cloudPull(opts), opts.json));

cloudCommand
  .command("restore")
  .description("Restore a retained cloud version (new head, then pull) or a local pre-sync checkpoint")
  .option("--version <number>", "Cloud version number to restore", Number)
  .option("--checkpoint <stamp>", "Local checkpoint stamp or full ref (see: summer cloud checkpoints)")
  .option("--project <path>", "Project root path")
  .option("--json", "Print JSON")
  .action(async (opts: SyncOptions & { version?: number; checkpoint?: string }) =>
    printResult(await cloudRestore(opts), opts.json)
  );

cloudCommand
  .command("checkpoints")
  .description("List local pre-sync checkpoints")
  .option("--project <path>", "Project root path")
  .option("--json", "Print JSON")
  .action(async (opts: SyncOptions) => printResult(await cloudCheckpoints(opts), opts.json));

const conflictsCommand = new Command("conflicts").description("Inspect and recover Summer Cloud conflict sets");

conflictsCommand
  .command("list", { isDefault: true })
  .description("List local Summer Cloud conflict sets")
  .option("--project <path>", "Project root path")
  .option("--json", "Print JSON")
  .action(async (opts: SyncOptions) => printResult(await cloudConflicts(opts), opts.json));

conflictsCommand
  .command("restore <path>")
  .description("Restore a preserved conflict file back into the project as a fresh edit")
  .option("--set <stamp>", "Conflict set stamp (defaults to the newest set containing the path)")
  .option("--project <path>", "Project root path")
  .option("--json", "Print JSON")
  .action(async (restorePath: string, opts: SyncOptions & { set?: string }) =>
    printResult(await cloudConflicts({ ...opts, restorePath }), opts.json)
  );

cloudCommand.addCommand(conflictsCommand);

function printResult(result: SyncResult, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.message);
  if (result.projectId) console.log(`Project: ${result.projectId}`);
  if (result.version !== undefined) console.log(`Version: ${result.version}`);
  for (const notice of result.notices ?? []) {
    console.log(`notice: ${notice}`);
  }
  if (result.details) {
    for (const [key, value] of Object.entries(result.details)) {
      console.log(`${key}: ${Array.isArray(value) ? value.length : String(value)}`);
    }
  }
}
