import { existsSync, statSync } from "fs";
import { homedir, platform } from "os";
import { basename, join } from "path";

/**
 * Where each platform's engine binary lives, shared by `summer install`,
 * `summer run`, and `summer doctor` so they can never disagree about what
 * "installed" means.
 *
 * Mac and Windows are installed by their platform installers into well-known
 * locations. Linux has no installer: `summer install` places (or symlinks) the
 * binary into ~/.summer/engine/, and SUMMER_ENGINE_BINARY points at a prebuilt
 * binary directly — the path cloud containers that ship their own build use.
 *
 * The Linux install *resolution* logic (which source to install from, which
 * release asset to pick, how to unpack it) also lives here so the CLI command
 * stays commander wiring + process I/O only.
 */

/** Env var naming the engine executable to launch and probe (absolute path).
 *  The ONE name shared with the autopilot scaffold (assets/autopilot/run.sh)
 *  and evals/mitl; `summer run --bin <path>` is its flag form. On macOS it is
 *  the executable inside the bundle (.../Summer.app/Contents/MacOS/Summer). */
export const ENGINE_BIN_ENV = "SUMMER_BIN";

/** Older name for the same override, documented for Linux cloud containers
 *  (`running-in-the-cloud`, CHANGELOG 3.0.0) and still honoured after
 *  ENGINE_BIN_ENV. `summer install` on Linux registers the binary it names. */
export const ENGINE_BINARY_ENV = "SUMMER_ENGINE_BINARY";

/** The explicit engine override in force — ENGINE_BIN_ENV first, then
 *  ENGINE_BINARY_ENV — or null when neither is set (blank counts as unset). */
export function engineBinaryOverride(
  env: NodeJS.ProcessEnv = process.env
): { name: string; path: string } | null {
  for (const name of [ENGINE_BIN_ENV, ENGINE_BINARY_ENV]) {
    const path = env[name]?.trim();
    if (path) return { name, path };
  }
  return null;
}

/**
 * Why an explicitly named engine path cannot be launched, or null when it can.
 * A `.app` bundle is refused even when it exists: `summer run` spawns the
 * executable directly, because `open` (the only way to launch a bundle)
 * activates the app and defeats background launches, and a binary copied OUT
 * of the bundle dies on its Sparkle @rpath — so the value has to be the
 * executable inside the bundle.
 */
export function describeEngineExecutableProblem(path: string, source: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (/\.app$/i.test(basename(trimmed))) {
    return (
      `${source} names the bundle ${trimmed}, not the engine executable. Pass the executable inside it: ` +
      `${join(trimmed, "Contents", "MacOS", "Summer")}\n` +
      "summer run spawns that executable directly: launching the .app would go through `open`, which activates " +
      "the app and defeats background launches, and a binary copied out of the bundle dies on its Sparkle @rpath."
    );
  }
  if (!existsSync(trimmed)) {
    return `${source} names ${trimmed}, but nothing exists there.`;
  }
  if (statSync(trimmed).isDirectory()) {
    return `${source} names ${trimmed}, which is a directory, not the engine executable.`;
  }
  return null;
}

/** Env var naming a direct artifact URL (tar.gz, zip, or raw binary) to install
 *  on Linux instead of the published release. */
export const ENGINE_URL_ENV = "SUMMER_ENGINE_URL";

/** The single executable name Linux release artifacts contain and installs
 *  register. Matches the release asset contents (.github/workflows/release.yml
 *  in the engine repository). */
export const LINUX_ENGINE_BINARY_NAME = "summer-linux-x86_64";

/**
 * Where Linux release artifacts are published today: GitHub Releases on the
 * engine repository (engine tags are v0.*; see .github/workflows/release.yml).
 * This is the ONE place to change when Linux artifacts move to the desktop
 * releases CDN — point it at an endpoint returning the same GitHub-style
 * releases JSON (an array of { tag_name, draft, prerelease, assets:[{ name,
 * browser_download_url }] }).
 */
export const LINUX_RELEASES_API_URL =
  "https://api.github.com/repos/SummerEngine/SummerEngine/releases?per_page=30";

/** Release asset naming contract with .github/workflows/release.yml. */
export const LINUX_ASSET_PATTERN = /^Summer-linux-x86_64.*\.tar\.gz$/;

export function linuxEngineInstallDir(): string {
  return join(homedir(), ".summer", "engine");
}

export function macEnginePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    "/Applications/Summer.app/Contents/MacOS/Summer",
    `${env.HOME}/Applications/Summer.app/Contents/MacOS/Summer`,
  ];
}

export function windowsEnginePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    `${env.LOCALAPPDATA}\\SummerEngine\\current\\Summer.exe`,
    `${env.LOCALAPPDATA}\\Programs\\Summer Engine\\Summer.exe`,
    `${env.PROGRAMFILES}\\Summer Engine\\Summer.exe`,
  ];
}

export function linuxEnginePaths(): string[] {
  return [join(linuxEngineInstallDir(), LINUX_ENGINE_BINARY_NAME)];
}

export function engineBinaryCandidates(
  os: NodeJS.Platform = platform(),
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const override = engineBinaryOverride(env)?.path;
  const platformPaths =
    os === "darwin"
      ? macEnginePaths(env)
      : os === "linux"
        ? linuxEnginePaths()
        : windowsEnginePaths(env);
  return override ? [override, ...platformPaths] : platformPaths;
}

/** First existing engine binary for this machine, or null. SUMMER_BIN /
 *  SUMMER_ENGINE_BINARY wins when set and present; a set-but-missing override
 *  falls through to the platform locations rather than reporting a phantom
 *  install (`summer run` is stricter: see resolveRunBinary). */
export function findEngineBinary(
  os: NodeJS.Platform = platform(),
  env: NodeJS.ProcessEnv = process.env
): string | null {
  for (const path of engineBinaryCandidates(os, env)) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

// ------------------------------------------------------ Linux install source

export type LinuxInstallSource =
  | { kind: "binary"; path: string }
  | { kind: "url"; url: string }
  | { kind: "release"; apiUrl: string };

/**
 * Resolution order for `summer install` on Linux:
 *   1. SUMMER_ENGINE_BINARY — an existing engine binary on disk (the path cloud
 *      containers with a prebuilt engine use). Registered, nothing downloaded.
 *   2. SUMMER_ENGINE_URL — any artifact URL: .tar.gz, .zip, or a raw executable.
 *   3. The published Linux release artifact (LINUX_RELEASES_API_URL).
 */
export function resolveLinuxInstallSource(
  env: NodeJS.ProcessEnv = process.env
): LinuxInstallSource {
  const binary = env[ENGINE_BINARY_ENV]?.trim();
  if (binary) return { kind: "binary", path: binary };
  const url = env[ENGINE_URL_ENV]?.trim();
  if (url) return { kind: "url", url };
  return { kind: "release", apiUrl: LINUX_RELEASES_API_URL };
}

export interface LinuxReleaseAsset {
  version: string;
  url: string;
  /** Sibling "<asset>.sha256" download URL when the release published one. */
  sha256Url?: string;
}

/**
 * Newest published (non-draft, non-prerelease) release that actually carries a
 * Linux artifact. Releases are shared between engine tags (v0.x) and CLI tags
 * (v1.x, v2.x), and CLI releases have no engine binaries — so "latest release"
 * is the wrong query and this scans instead.
 */
export function pickLinuxReleaseAsset(releases: unknown): LinuxReleaseAsset {
  const list = Array.isArray(releases) ? releases : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const release = entry as {
      tag_name?: unknown;
      draft?: unknown;
      prerelease?: unknown;
      assets?: unknown;
    };
    if (release.draft === true || release.prerelease === true) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const named = assets.filter(
      (asset): asset is { name: string; browser_download_url: string } =>
        Boolean(
          asset &&
            typeof asset === "object" &&
            typeof (asset as { name?: unknown }).name === "string" &&
            typeof (asset as { browser_download_url?: unknown })
              .browser_download_url === "string"
        )
    );
    const artifact = named.find((asset) => LINUX_ASSET_PATTERN.test(asset.name));
    if (!artifact) continue;
    const checksum = named.find((asset) => asset.name === `${artifact.name}.sha256`);
    return {
      version: typeof release.tag_name === "string" ? release.tag_name : "unknown",
      url: artifact.browser_download_url,
      ...(checksum ? { sha256Url: checksum.browser_download_url } : {}),
    };
  }
  throw new Error(
    "No published release carries a Linux engine artifact yet " +
      `(looked for ${String(LINUX_ASSET_PATTERN)}). ` +
      `Set ${ENGINE_URL_ENV} to a build artifact URL, or ${ENGINE_BINARY_ENV} to an existing binary, and re-run \`summer install\`.`
  );
}

/** How to unpack a downloaded Linux artifact, judged by its file name
 *  (query string ignored). Anything that is not a known archive is treated as
 *  the raw executable itself. */
export function linuxArchiveKind(nameOrUrl: string): "tar.gz" | "zip" | "binary" {
  const path = nameOrUrl.split(/[?#]/, 1)[0].toLowerCase();
  if (path.endsWith(".tar.gz") || path.endsWith(".tgz")) return "tar.gz";
  if (path.endsWith(".zip")) return "zip";
  return "binary";
}

/** Locate the engine executable inside an extracted artifact: the canonical
 *  name first, then the only file, then anything that looks like an engine
 *  build (covers artifacts packed straight from bin/). */
export function findExtractedEngineBinary(files: string[]): string | null {
  const canonical = files.find((f) => basename(f) === LINUX_ENGINE_BINARY_NAME);
  if (canonical) return canonical;
  if (files.length === 1) return files[0];
  return (
    files.find((f) => /godot\.linuxbsd\..*editor|summer.*linux/i.test(basename(f))) ??
    null
  );
}
