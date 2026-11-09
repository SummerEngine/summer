/**
 * summer preview — the running game in a local web page, so an agent's own
 * browser (Claude Code Desktop's Browser pane, the Codex app's in-app browser)
 * can see it, screenshot it and check it after every edit.
 *
 *   summer preview                 http://127.0.0.1:5199 (next free port if taken)
 *   summer preview --port 5300     exactly that port (Desktop rewrites this one)
 *   summer preview --open          also open it in the default browser
 *
 * Run it in the folder the agent session works in: the project itself, a
 * folder inside it, or a folder above it (a repo with the game in game/). The
 * preview shows that project's editor only, and adds a summer-preview entry to
 * <that folder>/.claude/launch.json (never changing other entries), which is
 * where Desktop reads it when the session started there; Desktop then starts
 * the preview itself and verifies changes with it. --no-launch-json skips that.
 * The server, the page and the writer live in core/preview/.
 */
import { Command } from "commander";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import open from "open";
import { EngineApiClient } from "../../core/api-client.js";
import { engineSelectionFromEnv, type EngineSelection } from "../../core/engine.js";
import { c, sym, tildeify } from "../../core/format.js";
import {
  DEFAULT_PREVIEW_PORT,
  previewLaunchEntry,
  writeClaudeLaunchConfig,
  type LaunchConfigResult,
} from "../../core/preview/launch-config.js";
import type { PreviewEngine } from "../../core/preview/preview-source.js";
import { PortInUseError, startPreviewServer, type PreviewServer } from "../../core/preview/server.js";
import { findSetupProjectRoot } from "../../project-memory/agent-instructions.js";

export interface PreviewCommandOptions {
  port?: string;
  launchJson?: boolean;
  open?: boolean;
  json?: boolean;
}

export interface PreviewIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  err(line: string): void;
  connect(selection: EngineSelection | undefined): Promise<PreviewEngine>;
  openUrl(url: string): Promise<void>;
}

/** --port asks for exactly that port; without it, 5199 or the next free one.
 *  A PORT variable is not read: shells often export one for a web app, and
 *  Desktop passes the port it picked in --port. */
export function resolvePreviewPort(flag: string | undefined): { port: number; strict: boolean } {
  if (flag === undefined || flag.trim() === "") return { port: DEFAULT_PREVIEW_PORT, strict: false };
  const port = Number(flag.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be a whole number from 0 through 65535, got "${flag}".`);
  }
  return { port, strict: true };
}

const SEARCH_DEPTH = 3;
const SEARCH_MAX_DIRS = 2000;

/** Folders holding project.godot below `dir`: the shallowest level that has
 *  any (depth <= 3, no hidden folders or node_modules, at most 2000 read). */
function projectsBelow(dir: string): string[] {
  const found: string[] = [];
  let read = 0;
  let level = [dir];
  for (let depth = 1; depth <= SEARCH_DEPTH && level.length > 0 && found.length === 0; depth += 1) {
    const next: string[] = [];
    for (const parent of level) {
      if (++read > SEARCH_MAX_DIRS) return found;
      let names: string[];
      try {
        names = readdirSync(parent, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const name of names) {
        const child = join(parent, name);
        if (existsSync(join(child, "project.godot"))) found.push(child);
        else next.push(child);
      }
    }
    level = next;
  }
  return found;
}

export interface PreviewProject {
  /** The folder with project.godot, or null outside any project. */
  projectRoot: string | null;
  /** Where .claude/launch.json goes: the folder the command runs in. */
  sessionRoot: string;
  /** The entry's cwd when the project sits below the session folder. */
  entryCwd?: string;
}

/** The project `summer preview` is for: at or above `cwd` (the same walk as
 *  `summer setup`), else the one project below it. Several below is an error. */
export function findPreviewProject(cwd: string): PreviewProject {
  const sessionRoot = realpathSync(resolve(cwd));
  const above = findSetupProjectRoot(sessionRoot);
  if (above) return { projectRoot: above, sessionRoot };
  if (sessionRoot === realpathSync(homedir()) || sessionRoot === parse(sessionRoot).root) {
    return { projectRoot: null, sessionRoot };
  }
  const below = projectsBelow(sessionRoot);
  if (below.length > 1) {
    throw new Error(
      `Several Summer projects below ${tildeify(sessionRoot)} (${below.map((dir) => relative(sessionRoot, dir)).join(", ")}). ` +
        "Run summer preview inside the one to show."
    );
  }
  if (below.length === 0) return { projectRoot: null, sessionRoot };
  return { projectRoot: below[0]!, sessionRoot, entryCwd: relative(sessionRoot, below[0]!).split(sep).join("/") };
}

function launchLine(result: LaunchConfigResult | null, project: PreviewProject, skipped: boolean): string {
  if (!project.projectRoot) {
    return `${sym.warn()} No Summer project here, above or below (no project.godot): .claude/launch.json not written.`;
  }
  if (skipped) return `${c.dim("·")} .claude/launch.json not written (--no-launch-json).`;
  if (!result) return `${sym.warn()} .claude/launch.json not written.`;
  const where = tildeify(result.path);
  const reader = `Claude Code Desktop reads it when the session's folder is ${tildeify(project.sessionRoot)}`;
  switch (result.status) {
    case "created":
    case "added":
      return `${sym.ok()} ${result.status === "created" ? "Wrote" : "Added summer-preview to"} ${where}. ${reader}: its Browser pane then starts this preview and checks it after each edit.`;
    case "kept":
      return `${sym.ok()} ${where} already has summer-preview${result.autoVerify ? "" : " (auto-verify is off in that file)"}. ${reader}.`;
    case "skipped":
      return `${sym.warn()} ${where} left as it is: ${result.reason}. Add this entry to its configurations: ${JSON.stringify(result.entry)}`;
  }
}

/** Start the preview; resolves with the running server (the command keeps it
 *  open until Ctrl-C). Throws on a bad --port, a taken explicit port, or
 *  several projects below the folder. */
export async function runPreview(opts: PreviewCommandOptions, io: PreviewIo): Promise<PreviewServer> {
  const { port, strict } = resolvePreviewPort(opts.port);
  const project = findPreviewProject(io.cwd);
  // Only this project's editor: never another project's through the global pointer.
  const selection = engineSelectionFromEnv(io.env) ?? (project.projectRoot ? { projectPath: project.projectRoot } : undefined);

  let server: PreviewServer;
  try {
    server = await startPreviewServer({ port, strictPort: strict, connect: () => io.connect(selection), log: io.err });
  } catch (err) {
    if (err instanceof PortInUseError) {
      throw new Error(
        `Port ${err.port} is in use. Pass another --port (0 picks any free one), or stop what runs there.`
      );
    }
    throw err;
  }

  let launch: LaunchConfigResult | null = null;
  const skipped = opts.launchJson === false;
  if (project.projectRoot && !skipped) {
    try {
      launch = writeClaudeLaunchConfig(project.sessionRoot, { entry: previewLaunchEntry(DEFAULT_PREVIEW_PORT, project.entryCwd) });
    } catch (err) {
      io.err(`${sym.warn()} .claude/launch.json not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (opts.json) {
    io.out(JSON.stringify({ ok: true, url: server.url, port: server.port, projectRoot: project.projectRoot, launchJson: launch }));
  } else {
    io.out(`${sym.arrow()} ${c.bold("Summer preview")}  ${server.url}`);
    io.out(`  Shows the running game, or the editor viewport when no game runs${project.projectRoot ? ` (${tildeify(project.projectRoot)})` : ""}. Ctrl-C to stop.`);
    io.out(`  ${launchLine(launch, project, skipped)}`);
  }
  if (opts.open) await io.openUrl(server.url).catch(() => undefined);
  return server;
}

function defaultIo(): PreviewIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    connect: (selection) => EngineApiClient.connect(selection),
    openUrl: async (url) => {
      await open(url);
    },
  };
}

export const previewCommand = new Command("preview")
  .description(
    "Show the running game (or the editor viewport) in a local web page an agent's browser can see; registers it in .claude/launch.json"
  )
  .option("--port <n>", `Port to serve on (default ${DEFAULT_PREVIEW_PORT}, or the next free one)`)
  .option("--no-launch-json", "Do not add the summer-preview entry to .claude/launch.json in this folder")
  .option("--open", "Also open the page in the default browser")
  .option("--json", "Print one JSON line with the URL instead of text")
  .action(async (opts: PreviewCommandOptions) => {
    const server = await runPreview(opts, defaultIo());
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await server.close();
    process.exit(0);
  });
