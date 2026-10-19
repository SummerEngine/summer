import { Command } from "commander";
import { noteCliError } from "../../core/cli-usage.js";
import { EngineInstallError, asInstallError, errorDetail, installFailureReason } from "../../core/engine-install.js";
import { installEngine } from "../../core/engine-installer.js";

// The install itself lives in core (shared with `summer dev` and the MCP's
// projects.open_local); this file is the command.
export * from "../../core/engine-installer.js";

// ------------------------------------------------------------------ command

/** The coded failure an error from installEngine stands for, or null for a
 *  bug (rethrown as before). A raw ENOSPC/EACCES/EPERM still gets its code. */
export function installCommandFailure(err: unknown): EngineInstallError | null {
  if (err instanceof EngineInstallError) return err;
  const reason = installFailureReason(err, "copy");
  return reason === "disk_space" || reason === "permission" ? asInstallError(err, reason, errorDetail) : null;
}

/** `summer install`: installEngine with a printed, coded failure and exit code 1. */
export async function runInstallCommand(
  opts: { path?: string; yes?: boolean },
  deps: {
    install?: typeof installEngine;
    error?: (line: string) => void;
    noteError?: (code: string) => void;
  } = {}
): Promise<void> {
  try {
    await (deps.install ?? installEngine)({
      path: opts.path,
      yes: opts.yes,
      log: (line) => console.log(line),
      isTTY: Boolean(process.stdin.isTTY),
    });
  } catch (err) {
    const failure = installCommandFailure(err);
    if (!failure) throw err;
    (deps.error ?? ((line: string) => console.error(line)))(failure.message);
    (deps.noteError ?? noteCliError)(failure.reason);
    process.exitCode = 1;
  }
}

export const installCommand = new Command("install")
  .description("Download and install Summer Engine")
  .option("--path <dir>", "Custom install directory (macOS: the engine goes in <dir>/Summer.app). summer remembers it, so later commands find this engine")
  .option("--yes", "Replace an already-installed engine without prompting")
  .action(async (opts: { path?: string; yes?: boolean }) => {
    await runInstallCommand(opts);
  });
