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
import { runCommand } from "./run.js";

const findEngineBinaryMock = vi.mocked(findEngineBinary);
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
  process.exitCode = undefined;
});

afterEach(async () => {
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
