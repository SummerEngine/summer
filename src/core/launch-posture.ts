/**
 * Editor launch posture — the ONE place that decides whether `summer run`
 * brings the Summer window to the front or leaves it in the background.
 *
 * The problem: when an agent drives Summer, every editor launch activates the
 * app and steals the user's screen, so they cannot keep working while their
 * game is built. The engine grows a launch posture for this:
 *
 *   focus       today's launch — the window appears and takes focus.
 *   background  `--summer-background` — the window exists but never activates
 *               or takes focus until the user clicks it.
 *   offscreen   `--summer-offscreen` — unfocusable window pushed off-screen
 *               (a sliver may stay visible; NOT invisible — main.cpp says so).
 *               Used by RunVerification / offscreen play instances, never by
 *               `summer run`.
 *
 * Default posture: BACKGROUND when stdout is not a TTY, FOCUS when it is. A
 * human typing `summer run` in a terminal wants to see the editor come up —
 * that is the whole point of the command for them. An agent (Claude Code's
 * Bash tool, an MCP host, a CI shell) never has a TTY on stdout, and for it
 * the launch is a means to an end: the user is doing something else on the
 * same Mac and must not be interrupted. `--focus` / `--background` override
 * the heuristic either way; pass one explicitly in scripts.
 *
 * Engine support: the flag ships in a future 0.5.x. Godot's argument parser
 * passes an unknown `--x` through to main_args instead of rejecting it
 * (main/main.cpp, final `else` of the parse loop), so an old engine would not
 * fail — it would silently launch WITH focus while the toolkit claimed a
 * background launch. That is the lie we refuse to tell: the flag is passed
 * only when the installed engine is known to honour it, and otherwise the
 * caller gets a one-line note. The engine is not running before `summer run`,
 * so /api/health cannot be consulted; the version is read from the installed
 * bundle (macOS Info.plist, Windows Velopack sq.version). Linux exposes no
 * version file, so it reads as unknown = unsupported until the engine ships a
 * pre-launch version source (see the ask in docs/TESTING.md).
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { platform } from "node:os";

export type LaunchPosture = "focus" | "background";

/** Engine flag for the background posture (main/main.cpp). */
export const BACKGROUND_LAUNCH_FLAG = "--summer-background";

/** First engine version that honours BACKGROUND_LAUNCH_FLAG. Engines at or
 *  below 0.5.65 predate it. Confirm against the engine release notes when the
 *  flag ships; until then this is the contract agreed with the engine side. */
export const BACKGROUND_LAUNCH_MIN_ENGINE_VERSION = "0.5.66";

export interface LaunchPostureFlags {
  focus?: boolean;
  background?: boolean;
}

export interface LaunchIo {
  /** `process.stdout.isTTY` — true only for a human at a terminal. */
  stdoutIsTTY: boolean;
}

/** BACKGROUND for agents (no TTY), FOCUS for a human at a terminal. */
export function defaultLaunchPosture(io: LaunchIo): LaunchPosture {
  return io.stdoutIsTTY ? "focus" : "background";
}

/** Explicit flag wins; both flags together is a caller error. */
export function resolveLaunchPosture(flags: LaunchPostureFlags, io: LaunchIo): LaunchPosture {
  if (flags.focus && flags.background) {
    throw new Error("Pass either --focus or --background, not both.");
  }
  if (flags.focus) return "focus";
  if (flags.background) return "background";
  return defaultLaunchPosture(io);
}

export type BackgroundLaunchSupport =
  | { supported: true; version: string }
  | { supported: false; reason: "engine_too_old"; version: string }
  | { supported: false; reason: "version_unknown"; version: null };

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(version: string): SemverParts | null {
  const cleaned = version.trim().replace(/^v/i, "").split(/[-+]/)[0];
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(cleaned);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Whether an installed engine version honours the background flag. An
 *  unreadable or unparseable version is "unknown", never "supported". */
export function backgroundLaunchSupport(installedVersion: string | null | undefined): BackgroundLaunchSupport {
  const parsed = installedVersion ? parseVersion(installedVersion) : null;
  if (!parsed || !installedVersion) return { supported: false, reason: "version_unknown", version: null };
  const min = parseVersion(BACKGROUND_LAUNCH_MIN_ENGINE_VERSION)!;
  return compareVersions(parsed, min) >= 0
    ? { supported: true, version: installedVersion.trim() }
    : { supported: false, reason: "engine_too_old", version: installedVersion.trim() };
}

export interface LaunchPlan {
  posture: LaunchPosture;
  /** Extra engine argv (after --path/--editor). Empty for focus, or when the
   *  engine cannot honour background. */
  extraArgs: string[];
  /** True when the launch will actually stay in the background. */
  background: boolean;
  /** One line for the caller when background was requested but will not
   *  happen (or cannot be verified). Null when there is nothing to say. */
  note: string | null;
}

/** The launch decision: which flags to pass and what to tell the caller. */
export function planLaunch(posture: LaunchPosture, support: BackgroundLaunchSupport): LaunchPlan {
  if (posture === "focus") {
    return { posture, extraArgs: [], background: false, note: null };
  }
  if (support.supported) {
    return { posture, extraArgs: [BACKGROUND_LAUNCH_FLAG], background: true, note: null };
  }
  const note =
    support.reason === "engine_too_old"
      ? `Background launch requested, but Summer Engine ${support.version} cannot launch without taking focus (needs ${BACKGROUND_LAUNCH_MIN_ENGINE_VERSION}+); launching with focus. Update Summer Engine (summer install) for background launches.`
      : `Background launch requested, but the installed Summer Engine version could not be read before launch, so the toolkit cannot tell whether it supports ${BACKGROUND_LAUNCH_FLAG} (needs ${BACKGROUND_LAUNCH_MIN_ENGINE_VERSION}+); launching with focus.`;
  return { posture, extraArgs: [], background: false, note };
}

// ---------------------------------------------------------------------------
// Installed engine version, read BEFORE launch (no engine to ask)
// ---------------------------------------------------------------------------

/** CFBundleShortVersionString out of a macOS Info.plist. */
export function parseMacBundleVersion(plistText: string): string | null {
  const match = plistText.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
  return match ? match[1].trim() : null;
}

/** Version string of an installed macOS bundle, or null when unreadable. */
export function readMacBundleVersion(appPath: string): string | null {
  try {
    return parseMacBundleVersion(readFileSync(join(appPath, "Contents", "Info.plist"), "utf-8"));
  } catch {
    return null;
  }
}

/** `<version>` out of a Velopack `sq.version` file (the nuspec Velopack drops
 *  next to the current binary on Windows). Best effort: any other shape reads
 *  as unknown. */
export function parseVelopackVersion(sqVersionText: string): string | null {
  const match = sqVersionText.match(/<version>\s*([^<\s]+)\s*<\/version>/i);
  return match ? match[1].trim() : null;
}

/** Walk up from `.../Summer.app/Contents/MacOS/Summer` to the bundle. */
function macBundlePathFor(binary: string): string | null {
  let current = dirname(binary);
  for (let depth = 0; depth < 4; depth++) {
    if (basename(current).endsWith(".app")) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Installed engine version for a resolved engine binary, or null. macOS reads
 * the bundle's Info.plist; Windows reads Velopack's sq.version beside the exe;
 * Linux has no version source today and always reads null.
 */
export function readInstalledEngineVersion(
  binary: string,
  os: NodeJS.Platform = platform()
): string | null {
  if (os === "darwin") {
    const bundle = macBundlePathFor(binary);
    return bundle ? readMacBundleVersion(bundle) : null;
  }
  if (os === "win32") {
    try {
      return parseVelopackVersion(readFileSync(join(dirname(binary), "sq.version"), "utf-8"));
    } catch {
      return null;
    }
  }
  return null;
}
