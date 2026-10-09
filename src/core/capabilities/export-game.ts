import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { platform } from "node:os";
import { engineSelectionFromEnv } from "../engine.js";
import { findEngineBinary } from "../engine-install.js";
import { readStoreJson, writeStoreJson } from "../store.js";
import { writeZip } from "../util/zip-write.js";
import { runEngine, type EngineRun } from "./engine-run.js";
import {
  BUNDLE_TARGETS,
  DOWNLOAD_TARGETS,
  SUMMER_GAMES_PRESET,
  bundlePresetSpec,
  ensurePreset,
  normalizeTargets,
  variantString,
  type EnsuredPreset,
  type PresetSpec,
  type StoreTarget,
} from "./export-presets.js";
import { engineTemplateInfo, findInstalledTemplate, templateFileFor, type TemplatesDependencies } from "./export-templates.js";
import { BuildToolError, hashFile, readSummerBundle, type SummerBundle } from "./summer-bundle.js";

export { runEngine, SUMMER_GAMES_PRESET, type EngineRun };

/**
 * summer_export_game: run the installed Summer Engine headless and return the
 * file the Summer Games store takes for the chosen targets.
 *
 *   <engine> --headless --path <project> --export-release "<preset>" <out>
 *
 * format "bundle" (default): the summer.bundle.v1 .zip for build-publications
 * (summer_publish_build). Summer runs its client.pck on its own templates in
 * the Summer Games apps, so no template and no signing. Without targets the
 * engine's in-memory "summer.games" preset is used as is (every platform
 * summer.build.json declares); with targets a named summer.games preset ticks
 * exactly those (export-presets.ts).
 *
 * format "download" (one target: web, macos or windows): what the store's
 * versions intake takes. web is a static HTML5 .zip (index.html at the root)
 * built on Summer's WebGPU/JSPI Forward+ template; macos is the .app zipped
 * (macos-universal, ad hoc signed, as the store asks for no signing); windows
 * is the .exe with its pack embedded, zipped (windows-x64). These need the
 * matching export template (summer_export_templates).
 *
 * --headless opens no window.
 */

export const LAST_EXPORT_FILE = "last-export.json";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export type ExportFormat = "bundle" | "download";

/** Store platform ids of the versions intake (summer-platform creatorstore). */
const STORE_VERSION_PLATFORM: Record<"web" | "macos" | "windows", string> = {
  web: "web",
  macos: "macos-universal",
  windows: "windows-x64",
};

/** Web zip limits of the store (summer-platform internal/creatorstore/webzip.go). */
const WEB_LIMITS = { zipBytes: 500 * 1024 * 1024, fileBytes: 200 * 1024 * 1024, files: 2000 };

/** Games without a server run on the phone apps only (summer-platform gameplatforms.StandaloneTargets). */
const STANDALONE_TARGETS: readonly string[] = ["ios", "android"];

/** Engine support per bundle target, for the recovery text when a target is missing. */
const TARGET_ENGINE_NOTE: Partial<Record<StoreTarget, string>> = {
  android: "Android in a summer.games bundle needs a Summer Engine newer than 0.7.0.",
};

export interface ExportGameInput {
  /** Project root (has project.godot). Defaults to the MCP's --project, then the working directory. */
  project?: string;
  /** Output .zip path. Defaults to <project>/.summer/exports/<name>-<time>.zip. */
  out?: string;
  /** Export with debug enabled (--export-debug). */
  debug?: boolean;
  /** Export preset name; the engine's own is "summer.games". Bundle format without targets only. */
  preset?: string;
  /** Store platforms: macos, windows, ios, android, web. */
  targets?: string[];
  /** "bundle" (store build for the Summer apps) or "download" (web build, native download). Default: bundle; web is always download. */
  format?: string;
  timeoutMs?: number;
}

export interface ExportGameResult {
  ok: true;
  format: ExportFormat;
  path: string;
  sha256: string;
  sizeBytes: number;
  project: string;
  preset: string;
  /** The targets asked for, when any were. */
  targets?: StoreTarget[];
  /** What happened to export_presets.cfg for the preset this export used. */
  presetChange?: EnsuredPreset["change"];
  debug: boolean;
  engine: string;
  durationMs: number;
  /** Bundle format: the bundle manifest. */
  bundle?: Omit<SummerBundle, "hostedBuild" | "files"> & { fileCount: number };
  /** Download format: the store versions platform id (web, macos-universal, windows-x64). */
  storePlatform?: string;
  /** Download format: files in the zip. */
  fileCount?: number;
  /** Download format: the project icon the export used, or null. */
  icon?: string | null;
  /** Download format: what signing the file carries. */
  signing?: string;
  /** Things the store will still refuse or warn about, in plain words. */
  warnings?: string[];
  next: string;
}

export interface LastExport {
  path: string;
  project: string;
  sha256: string;
  sizeBytes: number;
  exportedAt: string;
  /** Download exports: the store versions platform the file is for (summer_publish_build reads it). */
  storePlatform?: string;
}

export interface ExportGameDependencies {
  findBinary: () => string | null;
  run: (binary: string, args: string[], timeoutMs: number) => Promise<EngineRun>;
  now: () => Date;
  /** Template lookup for download exports (overridable in tests). */
  templates?: Partial<TemplatesDependencies>;
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

/** One value from project.godot ([section] key=value), unquoted. */
export function projectSetting(project: string, section: string, key: string): string | null {
  let current = "";
  for (const line of readFileSync(join(project, "project.godot"), "utf8").split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    if (current !== section || !line.startsWith(`${key}=`)) continue;
    const value = line.slice(key.length + 1).trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
    return quoted ? quoted[1].replace(/\\(["\\])/g, "$1") : value;
  }
  return null;
}

/** Lowercase ascii slug for file names and the macOS bundle id. */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^\x00-\x7f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "game"
  );
}

function resolveFormat(input: ExportGameInput, targets: StoreTarget[] | undefined): ExportFormat {
  const asked = input.format?.trim();
  if (asked && asked !== "bundle" && asked !== "download") {
    throw new BuildToolError("export_args_invalid", `Unknown format ${asked}.`, 'Recovery: use "bundle" or "download".');
  }
  if (asked === "download" || (!asked && targets?.includes("web"))) {
    if (!targets || targets.length !== 1 || !DOWNLOAD_TARGETS.includes(targets[0])) {
      throw new BuildToolError(
        "export_args_invalid",
        "A download export makes one file for one target: web, macos or windows.",
        'Recovery: pass exactly one of targets ["web"], ["macos"] or ["windows"]; iOS and Android are store builds only (format "bundle").'
      );
    }
    return "download";
  }
  const notBundle = (targets ?? []).filter((target) => !BUNDLE_TARGETS.includes(target));
  if (notBundle.length) {
    throw new BuildToolError(
      "export_args_invalid",
      `A summer.games bundle has no ${notBundle.join(", ")} client: the store takes web as a separate web build.`,
      'Recovery: export web on its own with targets ["web"] (format "download").'
    );
  }
  if (input.preset?.trim() && targets) {
    throw new BuildToolError(
      "export_args_invalid",
      "Pass targets or preset, not both: targets picks its own summer.games preset.",
      "Recovery: drop preset, or drop targets."
    );
  }
  return "bundle";
}

/** The rendering method the web build runs: the .web override, else the project's (Godot's default is Forward+). */
function webRenderer(project: string): string {
  return (
    projectSetting(project, "rendering", "renderer/rendering_method.web") ??
    projectSetting(project, "rendering", "renderer/rendering_method") ??
    "forward_plus"
  );
}

function downloadPresetSpec(target: "web" | "macos" | "windows", slug: string): PresetSpec {
  if (target === "web") {
    return {
      name: "Summer download Web",
      platform: "Web",
      options: {
        // Summer's WebGPU/JSPI template: Forward+ or Mobile in the browser,
        // no threads (so summer.games can frame it), no GDExtension.
        "variant/runtime_profile": variantString("summer-web-jspi-v1"),
        "variant/extensions_support": "false",
        "variant/thread_support": "false",
        "html/export_icon": "true",
      },
    };
  }
  if (target === "macos") {
    return {
      name: "Summer download macOS",
      platform: "macOS",
      options: {
        "binary_format/architecture": variantString("universal"),
        "application/bundle_identifier": variantString(`games.summer.${slug}`),
        // Built-in ad hoc signing works from every OS; the store needs no
        // Developer ID or notarization.
        "codesign/codesign": "1",
        "notarization/notarization": "0",
      },
    };
  }
  return {
    name: "Summer download Windows",
    platform: "Windows Desktop",
    options: {
      "binary_format/architecture": variantString("x86_64"),
      // One .exe: the store takes one archive per platform.
      "binary_format/embed_pck": "true",
      "codesign/enable": "false",
    },
  };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk(root);
  return files.sort();
}

async function runExport(
  deps: ExportGameDependencies,
  binary: string,
  project: string,
  preset: string,
  out: string,
  debug: boolean,
  timeoutMs: number,
  notes: string[]
): Promise<void> {
  const args = ["--headless", "--path", project, debug ? "--export-debug" : "--export-release", preset, out];
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
  if (run.code !== 0 || !existsSync(out)) {
    throw new BuildToolError(
      "export_failed",
      `Summer Engine did not export the game (exit ${run.code ?? run.signal}).`,
      [
        `Recovery: read the engine output, fix what it names, and export again. A missing "${preset}" preset means this engine predates summer.games exports: update Summer Engine.`,
        ...notes,
      ].join(" "),
      undefined,
      { output: outputTail(run.output) }
    );
  }
}

export async function exportGame(
  input: ExportGameInput,
  overrides: Partial<ExportGameDependencies> = {}
): Promise<ExportGameResult> {
  const deps = { ...defaultDependencies, ...overrides };
  const project = resolveExportProject(input.project);
  const targets = input.targets?.length ? normalizeTargets(input.targets) : undefined;
  const format = resolveFormat(input, targets);
  const debug = input.debug === true;
  const started = deps.now();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let out: string | null = null;
  if (input.out?.trim()) {
    out = isAbsolute(input.out) ? input.out : resolve(project, input.out);
    if (extname(out).toLowerCase() !== ".zip") {
      throw new BuildToolError(
        "export_path_invalid",
        `The export path ${out} must end in .zip: the store takes a .zip.`,
        "Recovery: pass out ending in .zip, or omit it."
      );
    }
    await mkdir(dirname(out), { recursive: true });
  }

  const binary = deps.findBinary();
  if (!binary) {
    throw new BuildToolError(
      "engine_not_installed",
      "Summer Engine is not installed on this machine.",
      'Recovery: run "summer install", or set SUMMER_BIN to the engine executable, then export again.'
    );
  }

  if (format === "download") {
    return exportDownload(deps, binary, project, targets![0] as "web" | "macos" | "windows", out, debug, timeoutMs, started);
  }

  out ??= join(await defaultExportDir(project), `${basename(project)}-${stamp(started)}.zip`);
  const before = existsSync(out) ? statSync(out).mtimeMs : null;
  const ensured = targets ? await ensurePreset(project, bundlePresetSpec(targets)) : undefined;
  const preset = ensured?.name ?? (input.preset?.trim() || SUMMER_GAMES_PRESET);
  const notes = (targets ?? []).flatMap((target) => TARGET_ENGINE_NOTE[target] ?? []);
  await runExport(deps, binary, project, preset, out, debug, timeoutMs, notes);
  if (before !== null && statSync(out).mtimeMs === before) {
    throw new BuildToolError(
      "export_failed",
      "Summer Engine exited without writing a new bundle.",
      "Recovery: read the engine output and export again."
    );
  }

  const bundle = await readSummerBundle(out);
  const missing = (targets ?? []).filter((target) => !bundle.targetPlatforms.includes(target));
  if (missing.length) {
    throw new BuildToolError(
      "export_target_unsupported",
      `This Summer Engine exported the bundle without ${missing.join(", ")}: its summer.games preset has no such platform.`,
      ["Recovery: update Summer Engine and export again, or export without those targets.", ...missing.flatMap((target) => TARGET_ENGINE_NOTE[target] ?? [])].join(
        " "
      ),
      undefined,
      { exportedPlatforms: bundle.targetPlatforms, path: out }
    );
  }
  const warnings: string[] = [];
  const desktopOnly = bundle.hosted ? [] : bundle.targetPlatforms.filter((target) => !STANDALONE_TARGETS.includes(target));
  if (desktopOnly.length) {
    warnings.push(
      `This game has no server, and the store runs games without a server on iPhone and Android only: summer_publish_build will refuse ${desktopOnly.join(", ")}. ` +
        'Export targets ["ios","android"] for the store build, and macOS or Windows as a download (format "download").'
    );
  }
  const { sha256, sizeBytes } = await hashFile(out);
  const last: LastExport = { path: out, project, sha256, sizeBytes, exportedAt: deps.now().toISOString() };
  await writeStoreJson(LAST_EXPORT_FILE, last);

  const { hostedBuild: _hostedBuild, files, ...summary } = bundle;
  return {
    ok: true,
    format,
    path: out,
    sha256,
    sizeBytes,
    project,
    preset,
    ...(targets ? { targets, presetChange: ensured!.change } : {}),
    debug,
    engine: binary,
    durationMs: deps.now().getTime() - started.getTime(),
    bundle: { ...summary, fileCount: files.length },
    ...(warnings.length ? { warnings } : {}),
    next: "Upload it to the game's store listing with summer_publish_build (gameId, clientVersion).",
  };
}

async function exportDownload(
  deps: ExportGameDependencies,
  binary: string,
  project: string,
  target: "web" | "macos" | "windows",
  requestedOut: string | null,
  debug: boolean,
  timeoutMs: number,
  started: Date
): Promise<ExportGameResult> {
  const name = projectSetting(project, "application", "config/name") || basename(project);
  const slug = slugify(name);
  const storePlatform = STORE_VERSION_PLATFORM[target];

  if (target === "web") {
    const renderer = webRenderer(project);
    if (renderer !== "forward_plus" && renderer !== "mobile") {
      throw new BuildToolError(
        "web_renderer_unsupported",
        `The project renders with ${renderer}; Summer's web template runs Forward+ or Mobile only.`,
        'Recovery: set Project Settings > Rendering > Renderer > Rendering Method (or its .web override) to "forward_plus", then export again.'
      );
    }
  }

  // Name the template the engine will need, before a long export fails on it.
  const templateFile = templateFileFor(target, debug);
  try {
    const info = await engineTemplateInfo({ findBinary: () => binary, run: deps.run, ...deps.templates });
    if (!findInstalledTemplate(info, templateFile)) {
      throw new BuildToolError(
        "export_template_missing",
        `The ${target} export needs the template ${templateFile}, and Summer Engine has none in ${info.searchDirs.join(" or ")}.`,
        `Recovery: call summer_export_templates with action "install" and platforms ["${target}"]${debug ? " and includeDebug true" : ""}, then export again.`,
        undefined,
        { template: templateFile, folder: info.folder }
      );
    }
  } catch (error) {
    // Only a missing template stops here; if the version probe fails, the
    // engine's own export check still names what is wrong.
    if (error instanceof BuildToolError && error.code === "export_template_missing") throw error;
  }

  const spec = downloadPresetSpec(target, slug);
  const ensured = await ensurePreset(project, spec);
  const exportsDir = await defaultExportDir(project);
  const work = join(exportsDir, `${slug}-${target}-${stamp(started)}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const out = requestedOut ?? join(exportsDir, `${slug}-${storePlatform}-${stamp(started)}.zip`);
  const warnings: string[] = [];
  let fileCount = 1;
  try {
    if (target === "macos") {
      // The macOS exporter writes the .app inside a .zip itself.
      const engineOut = join(work, `${slug}.zip`);
      await runExport(deps, binary, project, spec.name, engineOut, debug, timeoutMs, []);
      await rename(engineOut, out);
      warnings.push("macOS shows players an unidentified-developer prompt for an ad hoc signed app; the store accepts it as is.");
    } else {
      const engineOut = join(work, target === "web" ? "index.html" : `${slug}.exe`);
      await runExport(deps, binary, project, spec.name, engineOut, debug, timeoutMs, []);
      const files = await listFiles(work);
      const entries = files.map((file) => ({ name: relative(work, file).split(sep).join("/"), source: file }));
      if (target === "web") {
        const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
        const total = sizes.reduce((sum, size) => sum + size, 0);
        const tooBig = entries.find((_entry, index) => sizes[index] > WEB_LIMITS.fileBytes);
        if (entries.length > WEB_LIMITS.files || total > WEB_LIMITS.zipBytes || tooBig) {
          throw new BuildToolError(
            "web_build_too_large",
            `The web build has ${entries.length} files and ${Math.round(total / 1048576)} MiB${tooBig ? `; ${tooBig.name} is over 200 MiB` : ""}. The store takes at most ${WEB_LIMITS.files} files, 500 MiB, 200 MiB per file.`,
            "Recovery: exclude unused assets from the export (Project > Export > Resources) or compress textures, then export again."
          );
        }
      } else {
        warnings.push("The .exe is not code signed; Windows SmartScreen may warn players. The store accepts it as is.");
      }
      await writeZip(out, entries);
      fileCount = entries.length;
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const icon = projectSetting(project, "application", "config/icon");
  if (!icon) warnings.push("The project has no icon (Project Settings > Application > Config > Icon); the export uses the Summer default.");
  const { sha256, sizeBytes } = await hashFile(out);
  const last: LastExport = { path: out, project, sha256, sizeBytes, exportedAt: deps.now().toISOString(), storePlatform };
  await writeStoreJson(LAST_EXPORT_FILE, last);
  return {
    ok: true,
    format: "download",
    path: out,
    sha256,
    sizeBytes,
    project,
    preset: spec.name,
    targets: [target],
    presetChange: ensured.change,
    debug,
    engine: binary,
    durationMs: deps.now().getTime() - started.getTime(),
    storePlatform,
    fileCount,
    icon,
    signing: target === "macos" ? "ad hoc (built-in), not notarized" : "none",
    ...(warnings.length ? { warnings } : {}),
    next: `Upload it as the game's ${storePlatform} store version with summer_publish_build (gameId, clientVersion); it reads the platform from this export.`,
  };
}

/** The file the last summer_export_game wrote (bundle or download), when it is still on disk. */
export async function readLastExport(): Promise<LastExport | null> {
  const last = await readStoreJson<LastExport>(LAST_EXPORT_FILE).catch(() => null);
  return last && typeof last.path === "string" && existsSync(last.path) ? last : null;
}
