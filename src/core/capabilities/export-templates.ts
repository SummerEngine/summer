import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { findEngineBinary } from "../engine-install.js";
import { runEngine, type EngineRun } from "./engine-run.js";
import { hashFile, BuildToolError } from "./summer-bundle.js";

/**
 * summer_export_templates: list, download and install Summer Engine export
 * templates from Summer's CDN.
 *
 * The Summer Games store's own builds (summer.games bundles for iOS, Android,
 * macOS and Windows) need no template. Templates are for the store's web
 * build (the Summer WebGPU/JSPI Forward+ template, web_summer_jspi_*.zip) and
 * for native downloads (macos.zip, windows_*_x86_64.exe). The Mac app bundles
 * only macos.zip, the Windows app only the Windows exes, both bundle the web
 * pair when packaged with it, and Linux editors bundle nothing; the editor's
 * own downloader reads the stock Godot mirrors, which never carry Summer's
 * binaries. So this tool fetches them from
 *
 *   <base>/<summerVersion>/manifest.json   (schema summer.export-templates.v1)
 *
 * verifies each file's sha256 and installs it where the engine looks:
 * <user data>/export_templates/<FULL_CONFIG>/ (Godot's folder; Summer has not
 * renamed it), FULL_CONFIG being the Godot version the engine prints with
 * --version (4.7.2.stable, plus .mono for the .NET editor).
 */

export const TEMPLATES_URL_ENV = "SUMMER_TEMPLATES_URL";
export const DEFAULT_TEMPLATES_URL = "https://downloads.summer.games/engine-templates";
export const TEMPLATES_MANIFEST_SCHEMA = "summer.export-templates.v1";
export const TEMPLATE_PLATFORMS = ["web", "macos", "windows", "linux", "ios", "android"] as const;
export type TemplatePlatform = (typeof TEMPLATE_PLATFORMS)[number];
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_FILE = /^[A-Za-z0-9._-]+$/;
const VERSION_TIMEOUT_MS = 20_000;

export interface TemplateEntry {
  platform: TemplatePlatform;
  /** File name the engine looks for (macos.zip, web_summer_jspi_release.zip, ...). */
  file: string;
  /** Path of the file relative to the manifest. */
  path: string;
  sha256: string;
  size: number;
  debug: boolean;
  /** true: only the .mono folder; false: only the standard folder; null: both. */
  mono: boolean | null;
}

export interface TemplatesManifest {
  schema: typeof TEMPLATES_MANIFEST_SCHEMA;
  summerVersion: string;
  /** Godot FULL_CONFIG without .mono, e.g. 4.7.2.stable: the template folder name. */
  godotVersion: string;
  templates: TemplateEntry[];
}

export interface EngineTemplateInfo {
  engine: string;
  /** Template folder name: Godot FULL_CONFIG, e.g. 4.7.2.stable.mono. */
  folder: string;
  mono: boolean;
  summerVersion: string | null;
  /** Folders the engine reads, first match wins: inside the app, then the user folder. */
  searchDirs: string[];
  /** Where downloads go. */
  userDir: string;
}

export interface TemplatesDependencies {
  findBinary: () => string | null;
  run: (binary: string, args: string[], timeoutMs: number) => Promise<EngineRun>;
  fetch: typeof globalThis.fetch;
  os: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

const defaultDependencies = (): TemplatesDependencies => ({
  findBinary: () => findEngineBinary(osPlatform()),
  run: runEngine,
  fetch: (input, init) => globalThis.fetch(input, init),
  os: osPlatform(),
  env: process.env,
  home: homedir(),
});

/** Godot's user data folder + export_templates (editor_paths.cpp; get_godot_dir_name is "Godot", "godot" on Linux). */
export function userTemplatesRoot(os: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (os === "darwin") return join(home, "Library", "Application Support", "Godot", "export_templates");
  if (os === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Godot", "export_templates");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "godot", "export_templates");
}

/** Templates inside the installed app (editor_export_platform.cpp find_export_template). */
export function bundledTemplatesRoot(os: NodeJS.Platform, engine: string): string | null {
  if (os === "darwin") return join(dirname(dirname(engine)), "Resources", "export_templates");
  if (os === "win32") return join(dirname(engine), "export_templates");
  return null;
}

/** FULL_CONFIG from `--version` output ("4.7.2.stable.mono.custom_build.abc" -> "4.7.2.stable.mono"). */
export function parseTemplateFolder(output: string): string | null {
  const match = /(?<![\d.])(\d+\.\d+(?:\.\d+)?\.(?:stable|dev\d*|alpha\d*|beta\d*|rc\d*)(?:\.mono)?)\b/.exec(output);
  return match ? match[1] : null;
}

/** The Mac app's CFBundleShortVersionString is the Summer version. */
function macSummerVersion(engine: string): string | null {
  const plist = join(dirname(dirname(engine)), "Info.plist");
  if (!existsSync(plist)) return null;
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"));
  return match ? match[1].trim() : null;
}

export async function engineTemplateInfo(
  overrides: Partial<TemplatesDependencies> = {},
  summerVersion?: string
): Promise<EngineTemplateInfo> {
  const deps = { ...defaultDependencies(), ...overrides };
  const engine = deps.findBinary();
  if (!engine) {
    throw new BuildToolError(
      "engine_not_installed",
      "Summer Engine is not installed on this machine.",
      'Recovery: run "summer install", or set SUMMER_BIN to the engine executable.'
    );
  }
  let run: EngineRun;
  try {
    run = await deps.run(engine, ["--headless", "--version"], VERSION_TIMEOUT_MS);
  } catch (error) {
    throw new BuildToolError(
      "engine_launch_failed",
      `Summer Engine could not start: ${error instanceof Error ? error.message : String(error)}.`,
      'Recovery: run "summer doctor" and check the engine install.'
    );
  }
  const folder = parseTemplateFolder(run.output);
  if (!folder) {
    throw new BuildToolError(
      "engine_version_unknown",
      "Summer Engine did not print a version this tool can read.",
      'Recovery: run "summer doctor"; update Summer Engine if it is very old.',
      undefined,
      { output: run.output.trim().slice(-400) }
    );
  }
  const bundled = bundledTemplatesRoot(deps.os, engine);
  const userRoot = userTemplatesRoot(deps.os, deps.env, deps.home);
  const version = summerVersion?.trim() || (deps.os === "darwin" ? macSummerVersion(engine) : null);
  return {
    engine,
    folder,
    mono: folder.endsWith(".mono"),
    summerVersion: version,
    searchDirs: [...(bundled ? [join(bundled, folder)] : []), join(userRoot, folder)],
    userDir: join(userRoot, folder),
  };
}

/** Where the engine would find this template file, or null. */
export function findInstalledTemplate(info: EngineTemplateInfo, file: string): string | null {
  for (const dir of info.searchDirs) {
    const path = join(dir, file);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Template file the engine needs for a download export (export plugins' template names). */
export function templateFileFor(target: "web" | "macos" | "windows", debug: boolean): string {
  if (target === "web") return `web_summer_jspi_${debug ? "debug" : "release"}.zip`;
  if (target === "macos") return "macos.zip";
  return `windows_${debug ? "debug" : "release"}_x86_64.exe`;
}

export function templatesBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env[TEMPLATES_URL_ENV]?.trim() || DEFAULT_TEMPLATES_URL).replace(/\/+$/, "");
}

function notPublished(summerVersion: string, url: string): BuildToolError {
  return new BuildToolError(
    "templates_not_published",
    `Summer has not published export templates for Summer ${summerVersion} (${url}).`,
    "Recovery: store builds for iOS, Android, macOS and Windows need no template (summer_export_game with format bundle). " +
      "For web or native downloads use the Summer Engine Mac or Windows app, which bundles them, or update Summer Engine and retry.",
    404
  );
}

function parseManifest(raw: unknown, url: string): TemplatesManifest {
  const bad = (why: string) =>
    new BuildToolError("templates_manifest_invalid", `The templates manifest at ${url} is not valid: ${why}.`, "Recovery: retry later; report it if it persists.");
  const value = raw as Record<string, any>;
  if (!value || value.schema !== TEMPLATES_MANIFEST_SCHEMA) throw bad(`schema is not ${TEMPLATES_MANIFEST_SCHEMA}`);
  if (typeof value.summerVersion !== "string" || typeof value.godotVersion !== "string" || !Array.isArray(value.templates)) {
    throw bad("summerVersion, godotVersion or templates is missing");
  }
  const templates: TemplateEntry[] = value.templates.map((item: Record<string, any>, index: number) => {
    if (
      !(TEMPLATE_PLATFORMS as readonly string[]).includes(item?.platform) ||
      typeof item.file !== "string" ||
      !SAFE_FILE.test(item.file) ||
      typeof item.path !== "string" ||
      item.path.split("/").some((part: string) => !part || part === "." || part === "..") ||
      typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256) ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0 ||
      typeof item.debug !== "boolean" ||
      !(item.mono === null || typeof item.mono === "boolean")
    ) {
      throw bad(`templates[${index}] is malformed`);
    }
    return { platform: item.platform, file: item.file, path: item.path, sha256: item.sha256, size: item.size, debug: item.debug, mono: item.mono };
  });
  return { schema: TEMPLATES_MANIFEST_SCHEMA, summerVersion: value.summerVersion, godotVersion: value.godotVersion, templates };
}

export async function fetchTemplatesManifest(
  summerVersion: string,
  overrides: Partial<TemplatesDependencies> = {}
): Promise<{ manifest: TemplatesManifest; url: string }> {
  const deps = { ...defaultDependencies(), ...overrides };
  const url = `${templatesBaseUrl(deps.env)}/${encodeURIComponent(summerVersion)}/manifest.json`;
  let response: Response;
  try {
    response = await deps.fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new BuildToolError(
      "templates_unreachable",
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}.`,
      "Recovery: check the network and retry."
    );
  }
  if (response.status === 404 || response.status === 403) throw notPublished(summerVersion, url);
  if (!response.ok) {
    throw new BuildToolError("templates_unreachable", `${url} answered ${response.status}.`, "Recovery: retry later.", response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { manifest: parseManifest(body, url), url };
}

function servesFolder(entry: TemplateEntry, mono: boolean): boolean {
  return entry.mono === null || entry.mono === mono;
}

export interface TemplatesInput {
  action: "list" | "install";
  /** Template platforms to install (default: web). */
  platforms?: string[];
  /** Also install debug templates. */
  includeDebug?: boolean;
  /** Summer version of the installed engine, when the tool cannot read it (Windows, Linux). */
  summerVersion?: string;
}

function wantedPlatforms(platforms: string[] | undefined): TemplatePlatform[] {
  const list = platforms?.length ? platforms : ["web"];
  const unknown = list.filter((item) => !(TEMPLATE_PLATFORMS as readonly string[]).includes(item));
  if (unknown.length) {
    throw new BuildToolError(
      "template_platform_unknown",
      `Unknown template platform ${unknown.join(", ")}.`,
      `Recovery: use ${TEMPLATE_PLATFORMS.join(", ")}.`
    );
  }
  return TEMPLATE_PLATFORMS.filter((item) => list.includes(item));
}

function needVersion(info: EngineTemplateInfo): string {
  if (info.summerVersion) return info.summerVersion;
  throw new BuildToolError(
    "summer_version_unknown",
    "This tool cannot read the installed Summer version on this system.",
    "Recovery: pass summerVersion (shown in Summer Engine, Help > About, e.g. 0.7.1)."
  );
}

async function download(deps: TemplatesDependencies, url: string, entry: TemplateEntry, target: string): Promise<void> {
  let response: Response;
  try {
    response = await deps.fetch(url);
  } catch (error) {
    throw new BuildToolError("templates_unreachable", `Could not download ${url}: ${error instanceof Error ? error.message : String(error)}.`, "Recovery: retry.");
  }
  if (!response.ok || !response.body) {
    throw new BuildToolError("templates_unreachable", `${url} answered ${response.status}.`, "Recovery: retry later.", response.status);
  }
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as any),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(part)
    );
    const sha256 = `sha256:${hash.digest("hex")}`;
    if (sha256 !== entry.sha256 || size !== entry.size) {
      throw new BuildToolError(
        "template_checksum_mismatch",
        `${entry.file} did not match the manifest (got ${sha256}, ${size} bytes).`,
        "Recovery: retry; nothing was installed."
      );
    }
    await rename(part, target);
  } finally {
    await rm(part, { force: true });
  }
}

export async function exportTemplates(input: TemplatesInput, overrides: Partial<TemplatesDependencies> = {}) {
  const deps = { ...defaultDependencies(), ...overrides };
  const info = await engineTemplateInfo(deps, input.summerVersion);
  const installedFiles = () =>
    info.searchDirs.flatMap((dir) =>
      existsSync(dir) ? readdirSync(dir).filter((name) => !name.endsWith(".part")).map((file) => ({ file, dir })) : []
    );
  const engine = { engine: info.engine, folder: info.folder, summerVersion: info.summerVersion, searchDirs: info.searchDirs };

  if (input.action === "list") {
    let available: Array<TemplateEntry & { installed: boolean }> | null = null;
    let availability: string;
    if (info.summerVersion) {
      try {
        const { manifest, url } = await fetchTemplatesManifest(info.summerVersion, deps);
        available = manifest.templates
          .filter((entry) => servesFolder(entry, info.mono))
          .map((entry) => ({ ...entry, installed: findInstalledTemplate(info, entry.file) !== null }));
        availability = url;
      } catch (error) {
        if (!(error instanceof BuildToolError)) throw error;
        availability = `${error.code}: ${error.message.replace(` ${error.recovery}`, "")}`;
      }
    } else {
      availability = "summer_version_unknown: pass summerVersion to see what Summer publishes.";
    }
    return {
      ok: true as const,
      ...engine,
      installed: installedFiles(),
      available,
      availability,
      note: "Store builds (summer_export_game, format bundle) need no template. Web and native downloads need web_summer_jspi_release.zip, macos.zip or windows_release_x86_64.exe.",
    };
  }

  const platforms = wantedPlatforms(input.platforms);
  const summerVersion = needVersion(info);
  const { manifest, url } = await fetchTemplatesManifest(summerVersion, deps);
  const godotFolder = info.folder.replace(/\.mono$/, "");
  if (manifest.godotVersion !== godotFolder) {
    throw new BuildToolError(
      "templates_version_mismatch",
      `Summer ${summerVersion} templates are for Godot base ${manifest.godotVersion}, but this engine reads ${info.folder}.`,
      "Recovery: pass the summerVersion of the installed Summer Engine (Help > About), or update Summer Engine."
    );
  }
  const entries = manifest.templates.filter(
    (entry) => platforms.includes(entry.platform) && (input.includeDebug || !entry.debug) && servesFolder(entry, info.mono)
  );
  const missing = platforms.filter((item) => !entries.some((entry) => entry.platform === item));
  if (missing.length) {
    throw new BuildToolError(
      "template_not_published",
      `Summer ${summerVersion} publishes no ${missing.join(", ")} template${info.mono ? " for the .NET editor" : ""}.`,
      `Recovery: install from ${manifest.templates.map((entry) => entry.platform).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "nothing yet"}.`
    );
  }
  const base = url.slice(0, url.lastIndexOf("/") + 1);
  const results: Array<{ file: string; path: string; status: "installed" | "already_installed" }> = [];
  for (const entry of entries) {
    const target = join(info.userDir, entry.file);
    if (existsSync(target) && (await hashFile(target)).sha256 === entry.sha256) {
      results.push({ file: entry.file, path: target, status: "already_installed" });
      continue;
    }
    await download(deps, base + entry.path.split("/").map(encodeURIComponent).join("/"), entry, target);
    results.push({ file: entry.file, path: target, status: "installed" });
  }
  return {
    ok: true as const,
    ...engine,
    manifest: url,
    templates: results,
    next: "Export with summer_export_game (format download) for web, macos or windows.",
  };
}
