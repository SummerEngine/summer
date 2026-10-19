import { Command } from "commander";
import { existsSync, statSync } from "fs";
import { basename, join, resolve } from "path";
import { noteCliError } from "../../core/cli-usage.js";
import { ENGINE_BIN_ENV } from "../../core/engine-install.js";
import { launchEditor, resolveRunBinary } from "../../core/engine-launch.js";
import { resolveLaunchPosture } from "../../core/launch-posture.js";
import { getTemplateRegistry, resolveTemplate, type TemplateEntry } from "../../core/templates.js";
import { EngineInstallError, installEngine } from "../../core/engine-installer.js";
import { createProject, isEmptyProjectFolder } from "../../core/local-project.js";

/**
 * `summer dev [template] [dir]`: from nothing to an editor an agent can
 * drive, in one command. Installs Summer Engine when it is missing, creates
 * the project (the built-in 3d-basic unless a template is named), opens it
 * with `summer run`'s launch (background posture for agents, launch lock)
 * and waits until the editor's local API answers. A folder that already
 * holds project.godot is just opened.
 */

/** The starter project when no template is named. */
export const DEV_DEFAULT_TEMPLATE = "3d-basic";
/** The first open of a project imports every asset: wait this long for the API. */
export const DEV_WAIT_MS = 180_000;
const DEV_PROGRESS_MS = 10_000;
/** Where the project goes when the current folder already has other files. */
const DEFAULT_FOLDER = "my-game";

export type DevPlan =
  | { kind: "open"; dir: string; note?: string }
  | { kind: "create"; dir: string; entry: TemplateEntry }
  | { kind: "error"; code: string; message: string };

function isFolderArgument(arg: string, cwd: string): boolean {
  if (arg === "." || arg === ".." || /[\\/]/.test(arg)) return true;
  const path = resolve(cwd, arg);
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * What `summer dev` does with its arguments. One argument is a folder when it
 * is `.`, a path or an existing folder; else a template when one matches;
 * else the name of a new folder. Without a folder: the current one when it
 * is a project, empty or only dotfiles, else ./my-game (./<template> when a
 * template was named).
 */
export function planDev(args: readonly string[], cwd: string, entries: readonly TemplateEntry[]): DevPlan {
  let [templateArg, dirArg] = args as Array<string | undefined>;
  if (args.length === 1 && isFolderArgument(args[0], cwd)) [templateArg, dirArg] = [undefined, args[0]];

  let named: TemplateEntry | undefined;
  if (templateArg !== undefined) {
    const resolution = resolveTemplate(templateArg, entries);
    if (resolution.kind === "match") named = resolution.entry;
    else if (resolution.kind === "ambiguous") {
      return {
        kind: "error",
        code: "template",
        message: `'${templateArg}' matches several templates: ${resolution.candidates.map((c) => c.slug).join(", ")}. Name one.`,
      };
    } else if (args.length === 1) dirArg = templateArg;
    else return { kind: "error", code: "template", message: `No template matches '${templateArg}'. See them: npx -y summer-engine@latest list templates` };
  }
  const fallback = resolveTemplate(DEV_DEFAULT_TEMPLATE, entries);
  const entry = named ?? (fallback.kind === "match" ? fallback.entry : undefined);
  if (!entry) return { kind: "error", code: "template", message: `The ${DEV_DEFAULT_TEMPLATE} template is missing from this CLI. Update it: npx -y summer-engine@latest dev` };

  const dir =
    dirArg !== undefined
      ? resolve(cwd, dirArg)
      : existsSync(join(cwd, "project.godot")) || isEmptyProjectFolder(cwd)
        ? resolve(cwd)
        : join(resolve(cwd), named ? named.slug : DEFAULT_FOLDER);

  if (existsSync(join(dir, "project.godot"))) {
    return named ? { kind: "open", dir, note: `${dir} is already a Summer project: opening it as it is (${named.slug} was not applied).` } : { kind: "open", dir };
  }
  if (!isEmptyProjectFolder(dir)) {
    return {
      kind: "error",
      code: "not_empty",
      message: `${dir} has files but no project.godot. Pick a new folder: npx -y summer-engine@latest dev ${entry.slug} <new-folder>`,
    };
  }
  return { kind: "create", dir, entry };
}

/** The one line an agent reads when the editor is up. */
export function connectedLine(version: string, dir: string): string {
  return (
    `Connected: Summer Engine ${version} has ${dir} open. ` +
    "Next: call summer_get_project_context in your agent, then build the scene " +
    "(from a shell: npx -y summer-engine@latest engine get-project-context)."
  );
}

export interface DevOptions {
  focus?: boolean;
  background?: boolean;
  bin?: string;
}

export interface DevDeps {
  cwd?: string;
  install?: typeof installEngine;
  launch?: typeof launchEditor;
  waitMs?: number;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** Run `summer dev`; returns the exit code. Every failure has a code in the CLI usage line. */
export async function runDev(args: readonly string[], options: DevOptions, deps: DevDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const fail = (code: string, message?: string): number => {
    if (message) error(message);
    noteCliError(code);
    return 1;
  };

  let posture: ReturnType<typeof resolveLaunchPosture>;
  try {
    posture = resolveLaunchPosture(
      { focus: options.focus, background: options.background },
      { stdoutIsTTY: process.stdout.isTTY === true }
    );
  } catch (err) {
    return fail("invalid_input", (err as Error).message);
  }

  const plan = planDev(args, deps.cwd ?? process.cwd(), getTemplateRegistry());
  if (plan.kind === "error") return fail(plan.code, plan.message);

  // The engine first: a named build (--bin, SUMMER_BIN) must exist; otherwise
  // install the released one when none is installed.
  if (resolveRunBinary(options.bin).binary === null) {
    const named = options.bin?.trim() || process.env[ENGINE_BIN_ENV]?.trim();
    if (named) return fail("no_binary", (resolveRunBinary(options.bin) as { error: string }).error);
    log("Summer Engine is not installed yet. Installing it (free, about 660 MB, once)...");
    try {
      await (deps.install ?? installEngine)({ log });
    } catch (err) {
      if (err instanceof EngineInstallError) return fail(err.reason, err.message);
      throw err;
    }
  }

  if (plan.kind === "create") {
    try {
      await createProject(plan.entry, plan.dir, { name: basename(plan.dir), log });
    } catch (err) {
      return fail("template", (err as Error).message);
    }
  } else if (plan.note) {
    log(plan.note);
  }

  const result = await (deps.launch ?? launchEditor)({
    projectPath: plan.dir,
    posture,
    bin: options.bin,
    waitMs: deps.waitMs ?? DEV_WAIT_MS,
    progressEveryMs: DEV_PROGRESS_MS,
    out: { log, error },
  });
  switch (result.status) {
    case "running":
      log(connectedLine(result.health.version, plan.dir));
      return 0;
    case "starting":
      return fail(
        "timeout",
        `Summer Engine is still starting with ${plan.dir} (the first open imports every asset). ` +
          "Check again in a minute: npx -y summer-engine@latest status"
      );
    case "other_project":
      return fail("other_project");
    case "no_binary":
      return fail("no_binary");
    case "spawn_failed":
      return fail("launch");
  }
}

export const devCommand = new Command("dev")
  .description(
    "Start a game in one step: install Summer Engine if it is missing, create a starter project " +
      `(${DEV_DEFAULT_TEMPLATE} unless you name a template) in [dir] or this folder, open it in the editor, ` +
      "and wait until your agent can drive it. A folder with project.godot is just opened."
  )
  .argument("[template]", `Template slug (default ${DEV_DEFAULT_TEMPLATE}); or a folder, e.g. \`summer dev .\``)
  .argument("[dir]", `Project folder (default: this folder when it is a project, empty or only dotfiles; else ./${DEFAULT_FOLDER})`)
  .option("--background", "Open the editor without taking focus (default when an agent runs this)")
  .option("--focus", "Open the editor in front (default in a terminal)")
  .option("--bin <path>", `Engine executable to launch instead of the installed one (env: ${ENGINE_BIN_ENV})`)
  .action(async (template: string | undefined, dir: string | undefined, options: DevOptions) => {
    const args = [template, dir].filter((arg): arg is string => arg !== undefined);
    process.exitCode = await runDev(args, options);
  });
