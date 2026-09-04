import { describe, expect, it } from "vitest";
import {
  BACKGROUND_LAUNCH_FLAG,
  BACKGROUND_LAUNCH_MIN_ENGINE_VERSION,
  backgroundLaunchSupport,
  defaultLaunchPosture,
  parseMacBundleVersion,
  parseVelopackVersion,
  planLaunch,
  readInstalledEngineVersion,
  resolveLaunchPosture,
} from "./launch-posture.js";

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
    expect(backgroundLaunchSupport("0.5.65")).toEqual({ supported: false, reason: "engine_too_old", version: "0.5.65" });
    expect(backgroundLaunchSupport("0.5.44")).toMatchObject({ supported: false, reason: "engine_too_old" });
    expect(backgroundLaunchSupport(BACKGROUND_LAUNCH_MIN_ENGINE_VERSION)).toEqual({
      supported: true,
      version: BACKGROUND_LAUNCH_MIN_ENGINE_VERSION,
    });
    expect(backgroundLaunchSupport("v0.6.0")).toMatchObject({ supported: true });
    expect(backgroundLaunchSupport("0.5.70-beta.1")).toMatchObject({ supported: true });
  });

  it("an unreadable or unparseable version is unknown, never supported", () => {
    expect(backgroundLaunchSupport(null)).toEqual({ supported: false, reason: "version_unknown", version: null });
    expect(backgroundLaunchSupport("")).toMatchObject({ reason: "version_unknown" });
    expect(backgroundLaunchSupport("custom")).toMatchObject({ reason: "version_unknown" });
  });

  it("passes --summer-background only for a background launch on a supporting engine", () => {
    const ok = planLaunch("background", backgroundLaunchSupport("0.5.66"));
    expect(ok).toEqual({ posture: "background", extraArgs: [BACKGROUND_LAUNCH_FLAG], background: true, note: null });

    const focus = planLaunch("focus", backgroundLaunchSupport("0.5.66"));
    expect(focus).toEqual({ posture: "focus", extraArgs: [], background: false, note: null });
  });

  it("withholds the flag on an old engine and says in one line that it cannot launch without focus", () => {
    const old = planLaunch("background", backgroundLaunchSupport("0.5.65"));
    expect(old.extraArgs).toEqual([]);
    expect(old.background).toBe(false);
    expect(old.note).toContain("Summer Engine 0.5.65 cannot launch without taking focus");
    expect(old.note).toContain(BACKGROUND_LAUNCH_MIN_ENGINE_VERSION);
    expect(old.note?.split("\n")).toHaveLength(1);
  });

  it("withholds the flag when the version is unknown and says the toolkit could not tell", () => {
    const unknown = planLaunch("background", backgroundLaunchSupport(null));
    expect(unknown.extraArgs).toEqual([]);
    expect(unknown.note).toContain("could not be read before launch");
    expect(unknown.note).toContain(BACKGROUND_LAUNCH_FLAG);
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
