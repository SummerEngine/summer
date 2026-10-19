/**
 * summer preview — the running game in a local web page, so an agent's own
 * browser (Claude Code Desktop's Browser pane, the Codex app's in-app browser)
 * can see it, screenshot it and check it after every edit.
 *
 *   summer preview                 http://127.0.0.1:5199 (next free port if taken)
 *   summer preview --port 5300     exactly that port (also PORT, which Desktop sets)
 *   summer preview --open          also open it in the default browser
 *
 * Inside a Summer project it adds a summer-preview entry to the project's
 * .claude/launch.json (never changing other entries), so Desktop starts the
 * preview itself and verifies changes with it. --no-launch-json skips that.
 * The server, the page and the writer live in core/preview/.
 */
import { Command } from "commander";
import open from "open";
import { EngineApiClient } from "../../core/api-client.js";
import { engineSelectionFromEnv, type EngineSelection } from "../../core/engine.js";
import { c, sym, tildeify } from "../../core/format.js";
import { DEFAULT_PREVIEW_PORT, writeClaudeLaunchConfig, type LaunchConfigResult } from "../../core/preview/launch-config.js";
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

/** --port, then PORT (Claude Code Desktop passes the port it picked), then the default. */
export function resolvePreviewPort(flag: string | undefined, env: NodeJS.ProcessEnv): { port: number; strict: boolean } {
  const raw = flag ?? env.PORT;
  if (raw === undefined || raw.trim() === "") return { port: DEFAULT_PREVIEW_PORT, strict: false };
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be a whole number from 0 through 65535, got "${raw}".`);
  }
  return { port, strict: true };
}

function launchLine(result: LaunchConfigResult | null, projectRoot: string | null): string {
  if (!projectRoot) {
    return `${sym.warn()} Not inside a Summer project (no project.godot here or above): .claude/launch.json not written.`;
  }
  if (!result) return `${c.dim("·")} .claude/launch.json not written (--no-launch-json).`;
  const where = tildeify(result.path);
  switch (result.status) {
    case "created":
    case "added":
      return `${sym.ok()} ${result.status === "created" ? "Wrote" : "Added summer-preview to"} ${where}: Claude Code Desktop's Browser pane starts this preview and checks it after each edit.`;
    case "kept":
      return `${sym.ok()} ${where} already has summer-preview${result.autoVerify ? "" : " (auto-verify is off in that file)"}.`;
    case "skipped":
      return `${sym.warn()} ${where} left as it is: ${result.reason}. Add this entry to its configurations: ${JSON.stringify(result.entry)}`;
  }
}

/** Start the preview; resolves with the running server (the command keeps it
 *  open until Ctrl-C). Throws on a bad --port or a taken explicit port. */
export async function runPreview(opts: PreviewCommandOptions, io: PreviewIo): Promise<PreviewServer> {
  const { port, strict } = resolvePreviewPort(opts.port, io.env);
  const projectRoot = findSetupProjectRoot(io.cwd);
  // The editor for this project when there is one, as the MCP server picks it.
  const selection = engineSelectionFromEnv(io.env) ?? (projectRoot ? { cwd: projectRoot } : undefined);

  let server: PreviewServer;
  try {
    server = await startPreviewServer({ port, strictPort: strict, connect: () => io.connect(selection) });
  } catch (err) {
    if (err instanceof PortInUseError) {
      throw new Error(
        `Port ${err.port} is in use. Pass another --port (0 picks any free one), or stop what runs there.`
      );
    }
    throw err;
  }

  let launch: LaunchConfigResult | null = null;
  if (projectRoot && opts.launchJson !== false) {
    try {
      launch = writeClaudeLaunchConfig(projectRoot);
    } catch (err) {
      io.err(`${sym.warn()} .claude/launch.json not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (opts.json) {
    io.out(JSON.stringify({ ok: true, url: server.url, port: server.port, projectRoot, launchJson: launch }));
  } else {
    io.out(`${sym.arrow()} ${c.bold("Summer preview")}  ${server.url}`);
    io.out(`  Shows the running game, or the editor viewport when no game runs. Ctrl-C to stop.`);
    io.out(`  ${launchLine(launch, projectRoot)}`);
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
  .option("--port <n>", `Port to serve on (default ${DEFAULT_PREVIEW_PORT}, or the next free one; PORT works too)`)
  .option("--no-launch-json", "Do not add the summer-preview entry to the project's .claude/launch.json")
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
