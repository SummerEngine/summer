import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSummerDirForTests } from "../../core/store.js";

vi.mock("../../core/engine-install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/engine-install.js")>();
  return { ...actual, findEngineBinary: vi.fn(() => null) };
});

vi.mock("../../core/engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/engine.js")>();
  return {
    ...actual,
    getApiPort: vi.fn(async () => 6543),
    checkEngineHealth: vi.fn(async () => null),
  };
});

vi.mock("../../core/launch-posture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/launch-posture.js")>();
  return {
    ...actual,
    // Never touch a real binary in tests: the pre-launch decision is mocked to
    // the structured support answers the real detector produces.
    detectBackgroundLaunchSupport: vi.fn(async () => actual.backgroundLaunchSupport(null)),
  };
});

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: vi.fn(() => fakeChild()) };
});

/** A spawn() double that behaves like a real ChildProcess for the bits
 *  `summer run` touches: unref() and the async "error" event. Set
 *  `nextSpawnError` before the call to emit ENOENT/EACCES on the next tick. */
let nextSpawnError: NodeJS.ErrnoException | null = null;
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  const error = nextSpawnError;
  nextSpawnError = null;
  if (error) setTimeout(() => child.emit("error", error), 0);
  return child;
}

import { spawn } from "child_process";
import { checkEngineHealth } from "../../core/engine.js";
import { findEngineBinary } from "../../core/engine-install.js";
import { backgroundLaunchSupport, detectBackgroundLaunchSupport } from "../../core/launch-posture.js";
import { runCommand } from "./run.js";

const findEngineBinaryMock = vi.mocked(findEngineBinary);
const detectMock = vi.mocked(detectBackgroundLaunchSupport);
/** Shorthand: what the detector says about the installed engine. */
function engineSupport(version: string | null, helpProbe: boolean | null = null): void {
  detectMock.mockResolvedValue(backgroundLaunchSupport(version, helpProbe));
}

/** `summer run` reads process.stdout.isTTY to tell a human from an agent. */
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
function setStdoutTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true });
}
function restoreStdoutTTY(): void {
  if (originalIsTTY) Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
}
const checkEngineHealthMock = vi.mocked(checkEngineHealth);
const spawnMock = vi.mocked(spawn);

let root = "";
let logs: string[] = [];
let errors: string[] = [];
const originalExitCode = process.exitCode;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-run-test-"));
  setSummerDirForTests(join(root, ".summer"));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  findEngineBinaryMock.mockReset();
  findEngineBinaryMock.mockReturnValue(null);
  checkEngineHealthMock.mockReset();
  checkEngineHealthMock.mockResolvedValue(null);
  spawnMock.mockClear();
  nextSpawnError = null;
  detectMock.mockReset();
  engineSupport(null);
  // Existing tests assume a human at a terminal (focus, no posture flags).
  setStdoutTTY(true);
  // Commander keeps parsed option values on the Command instance between
  // parseAsync calls; a --background from one test must not leak into the next.
  runCommand.setOptionValue("focus", undefined);
  runCommand.setOptionValue("background", undefined);
  process.exitCode = undefined;
});

afterEach(async () => {
  restoreStdoutTTY();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

describe("summer run engine resolution", () => {
  it("refuses a bare launch without --no-project (agents probe commands)", async () => {
    await runCommand.parseAsync([], { from: "user" });

    expect(findEngineBinaryMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--no-project");
  });

  it("asks the shared engine-install resolver and refuses to launch when it finds nothing", async () => {
    await runCommand.parseAsync(["--no-project"], { from: "user" });

    expect(findEngineBinaryMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Summer Engine not found");
    expect(errors.join("\n")).toContain("summer install");
  });

  it("launches whatever binary the shared resolver returns", async () => {
    findEngineBinaryMock.mockReturnValue("/opt/prebuilt/summer-linux-x86_64");
    checkEngineHealthMock
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ version: "0.9.0", project_name: "Demo" } as never);

    await runCommand.parseAsync(["--no-project"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "/opt/prebuilt/summer-linux-x86_64",
      ["--editor"],
      { detached: true, stdio: "ignore" }
    );
    expect(process.exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("Summer Engine running (v0.9.0) on port 6543");
    expect(logs.join("\n")).toContain("Project: Demo");
  });

  it("reports a binary that fails to start instead of crashing with a raw stack", async () => {
    findEngineBinaryMock.mockReturnValue("/opt/stale/summer-linux-x86_64");
    const enoent = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    nextSpawnError = enoent;

    await runCommand.parseAsync(["--no-project"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain(
      "Summer Engine binary failed to start: ENOENT (/opt/stale/summer-linux-x86_64)"
    );
    expect(logs.join("\n")).not.toContain("Summer Engine running");
  });
});

describe("summer run launch posture (focus vs background)", () => {
  const binary = "/Applications/Summer.app/Contents/MacOS/Summer";
  const up = { version: "0.5.66", project_name: "Demo" } as never;

  it("an agent (no TTY) on a supporting engine launches in the background with --summer-background", async () => {
    setStdoutTTY(false);
    findEngineBinaryMock.mockReturnValue(binary);
    engineSupport("0.5.66", true);
    checkEngineHealthMock.mockResolvedValueOnce(null).mockResolvedValue(up);

    await runCommand.parseAsync(["--no-project"], { from: "user" });

    expect(detectMock).toHaveBeenCalledWith(binary);
    expect(spawnMock).toHaveBeenCalledWith(binary, ["--editor", "--summer-background"], { detached: true, stdio: "ignore" });
    expect(logs.join("\n")).toContain("Launching Summer Engine in the background");
    expect(logs.join("\n")).not.toContain("cannot launch without taking focus");
  });

  it("a human at a terminal launches with focus, no posture flag, and no --help probe", async () => {
    setStdoutTTY(true);
    findEngineBinaryMock.mockReturnValue(binary);
    engineSupport("0.5.66", true);
    checkEngineHealthMock.mockResolvedValueOnce(null).mockResolvedValue(up);

    await runCommand.parseAsync(["--no-project"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith(binary, ["--editor"], { detached: true, stdio: "ignore" });
    expect(detectMock).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Launching Summer Engine...");
  });

  it("the --help probe decides before the version does: an unreadable version with a listed flag launches in the background", async () => {
    setStdoutTTY(false);
    findEngineBinaryMock.mockReturnValue("/home/u/.summer/engine/summer");
    engineSupport(null, true);
    checkEngineHealthMock.mockResolvedValueOnce(null).mockResolvedValue(up);

    await runCommand.parseAsync(["--no-project"], { from: "user" });

    expect(detectMock).toHaveBeenCalledWith("/home/u/.summer/engine/summer");
    expect(spawnMock).toHaveBeenCalledWith("/home/u/.summer/engine/summer", ["--editor", "--summer-background"], expect.anything());
    expect(logs.join("\n")).not.toContain("could not be probed");
  });

  it("a probe that says no wins over a new-looking version and explains itself", async () => {
    setStdoutTTY(false);
    findEngineBinaryMock.mockReturnValue(binary);
    engineSupport("0.5.66", false);
    checkEngineHealthMock.mockResolvedValueOnce(null).mockResolvedValue({ version: "0.5.66" } as never);

    await runCommand.parseAsync(["--no-project"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith(binary, ["--editor"], expect.anything());
    expect(logs.join("\n")).toContain("its --help does not list --summer-background");
  });

  it("uses the running engine's launchPostures advert for the post-launch note", async () => {
    setStdoutTTY(false);
    findEngineBinaryMock.mockReturnValue("/home/u/.summer/engine/summer");
    engineSupport(null);
    checkEngineHealthMock
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ version: "0.5.70", capabilities: { launchPostures: ["focus", "background", "offscreen"] } } as never);

    await runCommand.parseAsync(["--no-project"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith("/home/u/.summer/engine/summer", ["--editor"], expect.anything());
    expect(logs.join("\n")).toContain("advertises background launches");
  });

  it("--background from a terminal and --focus from an agent both override the heuristic", async () => {
    findEngineBinaryMock.mockReturnValue(binary);
    engineSupport("0.5.66", true);
    checkEngineHealthMock.mockResolvedValue(up);

    setStdoutTTY(true);
    checkEngineHealthMock.mockResolvedValueOnce(null);
    await runCommand.parseAsync(["--no-project", "--background"], { from: "user" });
    expect(spawnMock).toHaveBeenLastCalledWith(binary, ["--editor", "--summer-background"], expect.anything());

    runCommand.setOptionValue("background", undefined);
    setStdoutTTY(false);
    checkEngineHealthMock.mockResolvedValueOnce(null);
    await runCommand.parseAsync(["--no-project", "--focus"], { from: "user" });
    expect(spawnMock).toHaveBeenLastCalledWith(binary, ["--editor"], expect.anything());
  });

  it("refuses --focus together with --background before touching anything", async () => {
    findEngineBinaryMock.mockReturnValue(binary);
    await runCommand.parseAsync(["--no-project", "--focus", "--background"], { from: "user" });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("either --focus or --background");
  });

  it("an engine whose --help lacks the flag gets no flag and one line saying it cannot launch without focus", async () => {
    setStdoutTTY(false);
    findEngineBinaryMock.mockReturnValue(binary);
    engineSupport("0.5.65", false);
    checkEngineHealthMock.mockResolvedValueOnce(null).mockResolvedValue({ version: "0.5.65" } as never);

    await runCommand.parseAsync(["--no-project"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith(binary, ["--editor"], { detached: true, stdio: "ignore" });
    const out = logs.join("\n");
    expect(out).toContain("Summer Engine 0.5.65 cannot launch without taking focus (its --help does not list --summer-background)");
    expect(out).toContain("Launching Summer Engine...");
    expect(out).not.toContain("in the background");
  });

  it("an unreadable version gets no flag, an honest note, and a hint when the running engine turns out to support it", async () => {
    setStdoutTTY(false);
    findEngineBinaryMock.mockReturnValue("/home/u/.summer/engine/summer");
    engineSupport(null);
    checkEngineHealthMock.mockResolvedValueOnce(null).mockResolvedValue({ version: "0.5.70" } as never);

    await runCommand.parseAsync(["--no-project"], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith("/home/u/.summer/engine/summer", ["--editor"], expect.anything());
    const out = logs.join("\n");
    expect(out).toContain("could not be probed (--help) and its version could not be read");
    expect(out).toContain("should support background launches");
  });

  it("the project path still comes first and the posture flag last", async () => {
    setStdoutTTY(false);
    const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
    const project = join(root, "proj");
    await mk(project, { recursive: true });
    await wf(join(project, "project.godot"), "");
    findEngineBinaryMock.mockReturnValue(binary);
    engineSupport("0.5.66", true);
    checkEngineHealthMock.mockResolvedValueOnce(null).mockResolvedValue(up);

    await runCommand.parseAsync([project], { from: "user" });

    expect(spawnMock).toHaveBeenCalledWith(binary, ["--path", project, "--editor", "--summer-background"], expect.anything());
  });
});
