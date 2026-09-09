import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_LAUNCH_FLAG,
  BACKGROUND_LAUNCH_MIN_ENGINE_VERSION,
  HELP_PROBE_CACHE_FILE,
  advertisedBackgroundPosture,
  backgroundLaunchSupport,
  defaultLaunchPosture,
  detectBackgroundLaunchSupport,
  type HelpProbeSpawn,
  helpTextListsBackgroundFlag,
  parseMacBundleVersion,
  parseVelopackVersion,
  planLaunch,
  probeBackgroundLaunchSupport,
  readInstalledEngineVersion,
  resolveLaunchPosture,
} from "./launch-posture.js";
import { parseEngineCapabilities } from "./capability-skew.js";

describe("launch posture: who is driving", () => {
  it("defaults to focus for a human at a terminal and background for an agent (no TTY)", () => {
    expect(defaultLaunchPosture({ stdoutIsTTY: true })).toBe("focus");
    expect(defaultLaunchPosture({ stdoutIsTTY: false })).toBe("background");
  });

  it("an explicit flag wins over the TTY heuristic, both flags is an error", () => {
    expect(resolveLaunchPosture({ background: true }, { stdoutIsTTY: true })).toBe("background");
    expect(resolveLaunchPosture({ focus: true }, { stdoutIsTTY: false })).toBe("focus");
    expect(() => resolveLaunchPosture({ focus: true, background: true }, { stdoutIsTTY: false })).toThrow(
      /either --focus or --background/
    );
  });
});

describe("launch posture: engine version gating", () => {
  it("0.5.65 and below cannot launch in the background; the minimum and above can", () => {
    expect(backgroundLaunchSupport("0.5.65")).toEqual({ supported: false, source: "version", reason: "engine_too_old", version: "0.5.65" });
    expect(backgroundLaunchSupport("0.5.44")).toMatchObject({ supported: false, reason: "engine_too_old" });
    expect(backgroundLaunchSupport(BACKGROUND_LAUNCH_MIN_ENGINE_VERSION)).toEqual({
      supported: true,
      source: "version",
      version: BACKGROUND_LAUNCH_MIN_ENGINE_VERSION,
    });
    expect(backgroundLaunchSupport("v0.6.0")).toMatchObject({ supported: true });
    expect(backgroundLaunchSupport("0.5.70-beta.1")).toMatchObject({ supported: true });
  });

  it("an unreadable or unparseable version is unknown, never supported", () => {
    expect(backgroundLaunchSupport(null)).toEqual({ supported: false, source: "version", reason: "version_unknown", version: null });
    expect(backgroundLaunchSupport("")).toMatchObject({ reason: "version_unknown" });
    expect(backgroundLaunchSupport("custom")).toMatchObject({ reason: "version_unknown" });
  });

  it("the --help probe is definitive and outranks the version gate either way", () => {
    // Old-looking version but the binary lists the flag (e.g. a dev build): supported.
    expect(backgroundLaunchSupport("0.5.65", true)).toEqual({ supported: true, source: "help_probe", version: "0.5.65" });
    // New version whose help does not list it (flag not merged into that cut): not supported.
    expect(backgroundLaunchSupport("0.5.66", false)).toEqual({ supported: false, source: "help_probe", reason: "engine_too_old", version: "0.5.66" });
    // Unknown version, probe answered: still definitive.
    expect(backgroundLaunchSupport(null, true)).toMatchObject({ supported: true, source: "help_probe", version: null });
    // Probe could not run: version decides.
    expect(backgroundLaunchSupport("0.5.66", null)).toMatchObject({ supported: true, source: "version" });
    expect(helpTextListsBackgroundFlag("Usage: ...\n  --summer-offscreen  Run ...\n  --summer-background  Run with a normal window ...")).toBe(true);
    expect(helpTextListsBackgroundFlag("Usage: ...\n  --summer-offscreen  Run ...")).toBe(false);
  });

  it("probing a binary that does not exist answers null (unknown), never a claim", async () => {
    await expect(probeBackgroundLaunchSupport("/nonexistent/Summer", 500)).resolves.toBeNull();
  });

  it("reads the running engine's launchPostures advert, camelCase or snake_case, null when absent", () => {
    expect(advertisedBackgroundPosture(parseEngineCapabilities({ launchPostures: ["focus", "background", "offscreen"] }))).toBe(true);
    // Non-macOS builds parse the quiet flags but do not enforce them: ["focus"] only.
    expect(advertisedBackgroundPosture(parseEngineCapabilities({ launch_postures: ["focus"] }))).toBe(false);
    expect(advertisedBackgroundPosture(parseEngineCapabilities({ opKinds: ["PlayGame"] }))).toBeNull();
    expect(advertisedBackgroundPosture(undefined)).toBeNull();
  });

  it("passes --summer-background only for a background launch on a supporting engine", () => {
    const ok = planLaunch("background", backgroundLaunchSupport("0.5.66"));
    expect(ok).toEqual({ posture: "background", extraArgs: [BACKGROUND_LAUNCH_FLAG], background: true, note: null });

    const focus = planLaunch("focus", backgroundLaunchSupport("0.5.66"));
    expect(focus).toEqual({ posture: "focus", extraArgs: [], background: false, note: null });
  });

  it("withholds the flag when the version fallback says old, and says the probe could not run", () => {
    const old = planLaunch("background", backgroundLaunchSupport("0.5.65"));
    expect(old.extraArgs).toEqual([]);
    expect(old.background).toBe(false);
    expect(old.note).toContain("Summer Engine 0.5.65 could not be probed (--help) and its version predates");
    expect(old.note).toContain(BACKGROUND_LAUNCH_MIN_ENGINE_VERSION);
    expect(old.note?.split("\n")).toHaveLength(1);
  });

  it("withholds the flag when the version is unknown and says the toolkit could not tell", () => {
    const unknown = planLaunch("background", backgroundLaunchSupport(null));
    expect(unknown.extraArgs).toEqual([]);
    expect(unknown.note).toContain("could not be probed (--help) and its version could not be read");
    expect(unknown.note).toContain(BACKGROUND_LAUNCH_FLAG);
    // The main negative message: the binary itself answered no.
    const probedOld = planLaunch("background", backgroundLaunchSupport("0.5.65", false));
    expect(probedOld.note).toContain("Summer Engine 0.5.65 cannot launch without taking focus (its --help does not list --summer-background)");

    const probedNo = planLaunch("background", backgroundLaunchSupport(null, false));
    expect(probedNo.extraArgs).toEqual([]);
    expect(probedNo.note).toContain("this Summer Engine build cannot launch without taking focus (its --help does not list --summer-background)");
  });

  it("a focus launch never carries a note, whatever the engine", () => {
    expect(planLaunch("focus", backgroundLaunchSupport(null)).note).toBeNull();
    expect(planLaunch("focus", backgroundLaunchSupport("0.5.1")).note).toBeNull();
  });
});

describe("installed engine version readers", () => {
  it("reads CFBundleShortVersionString and Velopack <version>", () => {
    expect(
      parseMacBundleVersion("<plist><dict><key>CFBundleShortVersionString</key>\n<string>0.5.71</string></dict></plist>")
    ).toBe("0.5.71");
    expect(parseMacBundleVersion("<plist/>")).toBeNull();
    expect(parseVelopackVersion("<package><metadata><id>Summer</id><version>0.5.66</version></metadata></package>")).toBe(
      "0.5.66"
    );
    expect(parseVelopackVersion("not a nuspec")).toBeNull();
  });

  it("reads null (unknown) for a binary with no version source", () => {
    expect(readInstalledEngineVersion("/nonexistent/Summer.app/Contents/MacOS/Summer", "darwin")).toBeNull();
    expect(readInstalledEngineVersion("C:\\nowhere\\Summer.exe", "win32")).toBeNull();
    expect(readInstalledEngineVersion("/home/u/.summer/engine/summer", "linux")).toBeNull();
  });
});

/** A spawn double that plays back help text (or an error / a hang) for `--help`. */
function fakeHelpSpawn(behaviour: { stdout?: string; stderr?: string; error?: boolean; hang?: boolean }): HelpProbeSpawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setTimeout(() => {
      if (behaviour.error) return child.emit("error", new Error("spawn ENOENT"));
      if (behaviour.hang) return;
      if (behaviour.stdout) child.stdout.emit("data", behaviour.stdout);
      if (behaviour.stderr) child.stderr.emit("data", behaviour.stderr);
      child.emit("close", 0);
    }, 0);
    return child as unknown as ReturnType<HelpProbeSpawn>;
  }) as HelpProbeSpawn;
}

const HELP_WITH_FLAG = "Usage: Summer [options]\n  --summer-offscreen  Run offscreen.\n  --summer-background  Run with a normal window but never activate.\n";
const HELP_WITHOUT_FLAG = "Usage: Summer [options]\n  --summer-offscreen  Run offscreen.\n";

describe("--help probe (mocked help output)", () => {
  it("answers true when the help text lists the flag, false when it does not (stderr counts too)", async () => {
    await expect(probeBackgroundLaunchSupport("/x/Summer", 1000, fakeHelpSpawn({ stdout: HELP_WITH_FLAG }))).resolves.toBe(true);
    await expect(probeBackgroundLaunchSupport("/x/Summer", 1000, fakeHelpSpawn({ stderr: HELP_WITH_FLAG }))).resolves.toBe(true);
    await expect(probeBackgroundLaunchSupport("/x/Summer", 1000, fakeHelpSpawn({ stdout: HELP_WITHOUT_FLAG }))).resolves.toBe(false);
  });

  it("answers null (unknown) on a spawn error, a hang past the timeout, or no output at all", async () => {
    await expect(probeBackgroundLaunchSupport("/x/Summer", 1000, fakeHelpSpawn({ error: true }))).resolves.toBeNull();
    await expect(probeBackgroundLaunchSupport("/x/Summer", 20, fakeHelpSpawn({ hang: true }))).resolves.toBeNull();
    await expect(probeBackgroundLaunchSupport("/x/Summer", 1000, fakeHelpSpawn({}))).resolves.toBeNull();
  });
});

describe("detectBackgroundLaunchSupport — probe first, cached per binary, version as pre-check and fallback", () => {
  let root = "";
  let binary = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "summer-launch-probe-"));
    binary = join(root, "Summer");
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("no version pre-check: a dev build stamped 0.5.65 whose --help lists the flag is supported", async () => {
    const probe = vi.fn(async () => true);
    const support = await detectBackgroundLaunchSupport(binary, { installedVersion: "0.5.65", summerDir: root, probe });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(support).toEqual({ supported: true, source: "help_probe", version: "0.5.65" });
  });

  it("the probe decides for an unknown or new-enough version, and its answer is cached by path + mtime + size", async () => {
    const probe = vi.fn(async () => true);
    const first = await detectBackgroundLaunchSupport(binary, { installedVersion: null, summerDir: root, probe, now: 1 });
    expect(first).toEqual({ supported: true, source: "help_probe", version: null });
    expect(probe).toHaveBeenCalledTimes(1);

    const cache = JSON.parse(await readFile(join(root, HELP_PROBE_CACHE_FILE), "utf-8")) as { binaries: Record<string, { listsBackgroundFlag: boolean; probedAt: number }> };
    expect(cache.binaries[binary]).toMatchObject({ listsBackgroundFlag: true, probedAt: 1 });

    // Same install: no second --help.
    const second = await detectBackgroundLaunchSupport(binary, { installedVersion: "0.5.66", summerDir: root, probe });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ supported: true, source: "help_probe", version: "0.5.66" });

    // Reinstalled binary (different size): probed again, and a "no" wins over the version.
    await writeFile(binary, "#!/bin/sh\nexit 0\n# rebuilt without the flag\n");
    probe.mockResolvedValue(false);
    const third = await detectBackgroundLaunchSupport(binary, { installedVersion: "0.5.66", summerDir: root, probe });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(third).toEqual({ supported: false, source: "help_probe", reason: "engine_too_old", version: "0.5.66" });
  });

  it("falls back to the version only when the probe cannot answer, and caches nothing", async () => {
    const probe = vi.fn(async () => null);
    expect(await detectBackgroundLaunchSupport(binary, { installedVersion: "0.5.66", summerDir: root, probe })).toEqual({
      supported: true,
      source: "version",
      version: "0.5.66",
    });
    expect(await detectBackgroundLaunchSupport(binary, { installedVersion: "0.5.65", summerDir: root, probe })).toEqual({
      supported: false,
      source: "version",
      reason: "engine_too_old",
      version: "0.5.65",
    });
    expect(await detectBackgroundLaunchSupport(binary, { installedVersion: null, summerDir: root, probe })).toEqual({
      supported: false,
      source: "version",
      reason: "version_unknown",
      version: null,
    });
    await expect(readFile(join(root, HELP_PROBE_CACHE_FILE), "utf-8")).rejects.toThrow();
  });
});
