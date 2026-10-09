import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:os";
import { engineSelectionFromEnv } from "../engine.js";
import { findEngineBinary } from "../engine-install.js";
import { readStoreJson, writeStoreJson } from "../store.js";
import { BuildToolError, hashFile, readSummerBundle, type SummerBundle } from "./summer-bundle.js";

/**
 * summer_export_game: run the installed Summer Engine headless with the
 * summer.games export preset and return the .zip bundle it wrote.
 *
 *   <engine> --headless --path <project> --export-release "summer.games" <out>.zip
 *
 * Every project has the summer.games preset: the engine adds it in memory when
 * the project loads (editor_export.cpp _add_summer_games_preset), so no
 * export_presets.cfg edit and no export template is needed. --headless opens
 * no window. Later this can move to the editor's export.start bridge op once
 * that op supports the templateless summer.games platform.
 */

export const SUMMER_GAMES_PRESET = "summer.games";
export const LAST_EXPORT_FILE = "last-export.json";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL_BYTES = 8 * 1024;
const KILL_GRACE_MS = 5_000;

export interface ExportGameInput {
  /** Project root (has project.godot). Defaults to the MCP's --project, then the working directory. */
  project?: string;
  /** Output .zip path. Defaults to <project>/.summer/exports/<name>-<time>.zip. */
  out?: string;
  /** Export with debug enabled (--export-debug). */
  debug?: boolean;
  /** Export preset name; the engine's own is "summer.games". */
  preset?: string;
  timeoutMs?: number;
}

export interface ExportGameResult {
  ok: true;
  path: string;
  sha256: string;
  sizeBytes: number;
  project: string;
  preset: string;
  debug: boolean;
  engine: string;
  durationMs: number;
  bundle: Omit<SummerBundle, "hostedBuild" | "files"> & { fileCount: number };
  next: string;
}

export interface LastExport {
  path: string;
  project: string;
  sha256: string;
  sizeBytes: number;
  exportedAt: string;
}

export interface EngineRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
}

export interface ExportGameDependencies {
  findBinary: () => string | null;
  run: (binary: string, args: string[], timeoutMs: number) => Promise<EngineRun>;
  now: () => Date;
}

/** Spawn the engine (argv only, no shell), keep the last output, kill on timeout. */
export function runEngine(binary: string, args: string[], timeoutMs: number): Promise<EngineRun> {
  return new Promise((resolvePromise, reject) => {
    const child = nodeSpawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolvePromise({ code, signal, timedOut, output });
    });
  });
}

const defaultDependencies: ExportGameDependencies = {
  findBinary: () => findEngineBinary(platform()),
  run: runEngine,
  now: () => new Date(),
};

export function resolveExportProject(project?: string): string {
  const root = resolve(project?.trim() || engineSelectionFromEnv()?.projectPath || process.cwd());
  if (!existsSync(join(root, "project.godot"))) {
    throw new BuildToolError(
      "project_not_found",
      `${root} is not a Summer project (no project.godot).`,
      "Recovery: pass project with the folder that holds project.godot."
    );
  }
  return root;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
}

/** <project>/.summer/exports/, ignored by the editor and by git. */
async function defaultExportDir(project: string): Promise<string> {
  const dir = join(project, ".summer", "exports");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of [
    [".gdignore", ""],
    [".gitignore", "*\n"],
  ] as const) {
    const file = join(dir, name);
    if (!existsSync(file)) await writeFile(file, body);
  }
  return dir;
}

function outputTail(output: string): string {
  return output.trim().split("\n").slice(-40).join("\n");
}

export async function exportGame(
  input: ExportGameInput,
  overrides: Partial<ExportGameDependencies> = {}
): Promise<ExportGameResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const project = resolveExportProject(input.project);
  const preset = input.preset?.trim() || SUMMER_GAMES_PRESET;
  const debug = input.debug === true;
  const started = deps.now();

  let out: string;
  if (input.out?.trim()) {
    out = isAbsolute(input.out) ? input.out : resolve(project, input.out);
    if (extname(out).toLowerCase() !== ".zip") {
      throw new BuildToolError(
        "export_path_invalid",
        `The export path ${out} must end in .zip: the summer.games export is a bundle.`,
        "Recovery: pass out ending in .zip, or omit it."
      );
    }
    await mkdir(dirname(out), { recursive: true });
  } else {
    out = join(await defaultExportDir(project), `${basename(project)}-${stamp(started)}.zip`);
  }
  const before = existsSync(out) ? statSync(out).mtimeMs : null;

  const binary = deps.findBinary();
  if (!binary) {
    throw new BuildToolError(
      "engine_not_installed",
      "Summer Engine is not installed on this machine.",
      'Recovery: run "summer install", or set SUMMER_BIN to the engine executable, then export again.'
    );
  }

  const args = ["--headless", "--path", project, debug ? "--export-debug" : "--export-release", preset, out];
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let run: EngineRun;
  try {
    run = await deps.run(binary, args, timeoutMs);
  } catch (error) {
    throw new BuildToolError(
      "engine_launch_failed",
      `Summer Engine could not start: ${error instanceof Error ? error.message : String(error)}.`,
      'Recovery: run "summer doctor" and check the engine install.'
    );
  }
  if (run.timedOut) {
    throw new BuildToolError(
      "export_timeout",
      `The export did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`,
      "Recovery: a first export imports every asset; retry with a larger timeoutSeconds.",
      undefined,
      { output: outputTail(run.output) }
    );
  }
  const written = existsSync(out) ? await stat(out) : null;
  if (run.code !== 0 || !written || (before !== null && written.mtimeMs === before)) {
    throw new BuildToolError(
      "export_failed",
      `Summer Engine did not export the game (exit ${run.code ?? run.signal}).`,
      `Recovery: read the engine output, fix what it names, and export again. A missing "${preset}" preset means this engine predates summer.games exports: update Summer Engine.`,
      undefined,
      { output: outputTail(run.output) }
    );
  }

  const bundle = await readSummerBundle(out);
  const { sha256, sizeBytes } = await hashFile(out);
  const last: LastExport = { path: out, project, sha256, sizeBytes, exportedAt: deps.now().toISOString() };
  await writeStoreJson(LAST_EXPORT_FILE, last);

  const { hostedBuild: _hostedBuild, files, ...summary } = bundle;
  return {
    ok: true,
    path: out,
    sha256,
    sizeBytes,
    project,
    preset,
    debug,
    engine: binary,
    durationMs: deps.now().getTime() - started.getTime(),
    bundle: { ...summary, fileCount: files.length },
    next: "Upload it to the game's store listing with summer_publish_build (gameId, clientVersion).",
  };
}

/** The bundle the last summer_export_game wrote, when it is still on disk. */
export async function readLastExport(): Promise<LastExport | null> {
  const last = await readStoreJson<LastExport>(LAST_EXPORT_FILE).catch(() => null);
  return last && typeof last.path === "string" && existsSync(last.path) ? last : null;
}
