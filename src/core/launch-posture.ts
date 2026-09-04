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
 * so /api/health cannot be consulted. Two pre-launch sources, in order:
 *
 *   1. `<binary> --help` and look for the flag in the help text. `--help` is
 *      handled in Main::setup() before any display server exists
 *      (main.cpp `arg == "--help"` -> ERR_HELP), and on macOS it is in
 *      OS_MacOS::headless_args (os_macos.h), so the bundle runs as
 *      OS_MacOS_Headless: no NSApp, no window, no activation, no Dock bounce.
 *      Definitive on every engine version; the only probe that never lies.
 *   2. If the probe cannot run (spawn error, timeout), the installed version
 *      (macOS Info.plist, Windows Velopack sq.version) against the minimum.
 *      Linux exposes no version file, so it reads unknown = unsupported.
 *
 * Once the engine is up, /api/health `capabilities.launchPostures` (newer
 * engines) is the authoritative advert and is used for the post-launch note.
 *
 * `summer run` spawns the executable directly (Summer.app/Contents/MacOS/Summer
 * on macOS), never through `open` — LaunchServices would activate the app and
 * defeat the posture whatever flags were passed.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { platform } from "node:os";
import type { EngineCapabilities } from "./capability-skew.js";

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
  | { supported: true; source: "help_probe" | "version"; version: string | null }
  | { supported: false; source: "help_probe" | "version"; reason: "engine_too_old"; version: string | null }
  | { supported: false; source: "version"; reason: "version_unknown"; version: null };

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

/**
 * Whether the installed engine honours the background flag. The `--help`
 * probe answer (true/false) is definitive when it ran; a probe that could not
 * run (null) falls back to the version gate, where an unreadable or
 * unparseable version is "unknown", never "supported".
 */
export function backgroundLaunchSupport(
  installedVersion: string | null | undefined,
  helpProbe: boolean | null = null
): BackgroundLaunchSupport {
  const version = installedVersion?.trim() || null;
  if (helpProbe === true) return { supported: true, source: "help_probe", version };
  if (helpProbe === false) return { supported: false, source: "help_probe", reason: "engine_too_old", version };
  const parsed = version ? parseVersion(version) : null;
  if (!parsed || !version) return { supported: false, source: "version", reason: "version_unknown", version: null };
  const min = parseVersion(BACKGROUND_LAUNCH_MIN_ENGINE_VERSION)!;
  return compareVersions(parsed, min) >= 0
    ? { supported: true, source: "version", version }
    : { supported: false, source: "version", reason: "engine_too_old", version };
}

/** True when the help text of an engine binary lists the background flag. */
export function helpTextListsBackgroundFlag(helpText: string): boolean {
  return helpText.includes(BACKGROUND_LAUNCH_FLAG);
}

export const HELP_PROBE_TIMEOUT_MS = 5_000;

/**
 * Run `<binary> --help` and report whether the flag is listed: true / false,
 * or null when the probe could not answer (spawn error, timeout). Safe on
 * every version: --help exits in Main::setup() before a display server exists,
 * and the macOS bundle runs it headless (OS_MacOS::headless_args), so nothing
 * appears on screen and nothing is activated.
 */
export function probeBackgroundLaunchSupport(
  binary: string,
  timeoutMs: number = HELP_PROBE_TIMEOUT_MS
): Promise<boolean | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(output.length > 0 ? helpTextListsBackgroundFlag(output) : null));
  });
}

/**
 * The running engine's own word, once it is up: /api/health
 * `capabilities.launchPostures` (engine tool_net_thread.cpp, newer builds).
 * true / false when advertised, null when the engine predates the advert.
 */
export function advertisedBackgroundPosture(capabilities: EngineCapabilities | undefined | null): boolean | null {
  const postures = capabilities?.launchPostures;
  if (!postures) return null;
  return postures.includes("background");
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
  const which = support.version ? `Summer Engine ${support.version}` : "this Summer Engine build";
  const note =
    support.reason === "engine_too_old"
      ? `Background launch requested, but ${which} cannot launch without taking focus (${support.source === "help_probe" ? `its --help does not list ${BACKGROUND_LAUNCH_FLAG}` : `needs ${BACKGROUND_LAUNCH_MIN_ENGINE_VERSION}+`}); launching with focus. Update Summer Engine (summer install) for background launches.`
      : `Background launch requested, but the installed Summer Engine could not be probed (--help) and its version could not be read before launch, so the toolkit cannot tell whether it supports ${BACKGROUND_LAUNCH_FLAG} (needs ${BACKGROUND_LAUNCH_MIN_ENGINE_VERSION}+); launching with focus.`;
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
