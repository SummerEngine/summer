import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./engine-install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine-install.js")>();
  return { ...actual, findEngineBinary: vi.fn(() => null) };
});

vi.mock("./engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine.js")>();
  return { ...actual, checkEngineHealth: vi.fn(async () => null) };
});

import type { EngineApiClient } from "./api-client.js";
import { checkEngineHealth } from "./engine.js";
import { findEngineBinary } from "./engine-install.js";
import type { LaunchEditorOptions, LaunchEditorResult } from "./engine-launch.js";
import { _resetSelfStartForTests, DEV_COMMAND, selfStartEngine, SELF_START_RECOVERY } from "./engine-self-start.js";
import { EngineNotRunningError } from "./error-codes.js";
import { setSummerDirForTests } from "./store.js";

const findEngineBinaryMock = vi.mocked(findEngineBinary);
const healthMock = vi.mocked(checkEngineHealth);
const up = { ok: true, engine: "summer", version: "0.9.9", port: 6551, instanceId: "fake-1" };
const notRunning = () => new EngineNotRunningError("Summer Engine is not running.", "no api-token found");
const fakeClient = { fake: true } as unknown as EngineApiClient;
const on = { SUMMER_AUTO_LAUNCH: "1" } as NodeJS.ProcessEnv;

let root = "";
let project = "";
let elsewhere = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "summer-self-start-")));
  setSummerDirForTests(join(root, ".summer"));
  project = join(root, "game");
  mkdirSync(join(project, "scenes"), { recursive: true });
  writeFileSync(join(project, "project.godot"), "");
  elsewhere = join(root, "notes");
  mkdirSync(elsewhere);
  findEngineBinaryMock.mockReset();
  findEngineBinaryMock.mockReturnValue("/Applications/Summer.app/Contents/MacOS/Summer");
  healthMock.mockReset();
  healthMock.mockResolvedValue(null);
  _resetSelfStartForTests();
});

afterEach(() => {
  setSummerDirForTests(null);
  rmSync(root, { recursive: true, force: true });
});

function launcher(result: LaunchEditorResult) {
  return vi.fn(async (_options: LaunchEditorOptions) => result);
}

async function failureOf(run: Promise<unknown>): Promise<EngineNotRunningError> {
  const error = await run.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(EngineNotRunningError);
  return error as EngineNotRunningError;
}

describe("the MCP opens the session's project when no editor runs", () => {
  it("launches the project the agent works in (background), waits, and returns a connected client", async () => {
    const launch = launcher({ status: "running", launched: true, port: 6551, health: up as never });
    const connect = vi.fn(async () => fakeClient);

    const client = await selfStartEngine({ cwd: join(project, "scenes") }, notRunning(), { env: on, launch, connect });

    expect(client).toBe(fakeClient);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0]).toMatchObject({ projectPath: project, posture: "background" });
    expect(connect).toHaveBeenCalledWith({ cwd: join(project, "scenes") });
  });

  it("says the editor is starting when the first open outlasts one call, then waits instead of launching again", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const launch = launcher({ status: "starting", binary: "/fake/Summer" });
    const connect = vi.fn(async (): Promise<EngineApiClient> => {
      throw new Error("not yet");
    });

    const first = await failureOf(selfStartEngine({ projectPath: project }, notRunning(), { env: on, launch, connect, now, waitMs: 0 }));
    expect(first.message).toBe("Summer Engine is starting.");
    expect(first.recovery).toBe(SELF_START_RECOVERY.starting(project));

    // withEngine's immediate retry gets the same answer, with no second wait.
    expect(await failureOf(selfStartEngine({ projectPath: project }, notRunning(), { env: on, launch, connect, now, waitMs: 0 }))).toBe(first);

    clock += 30_000;
    connect.mockResolvedValueOnce(fakeClient);
    const client = await selfStartEngine({ projectPath: project }, notRunning(), { env: on, launch, connect, now, waitMs: 0 });
    expect(client).toBe(fakeClient);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("without the engine installed, names the one command that installs and opens it", async () => {
    findEngineBinaryMock.mockReturnValue(null);
    const launch = launcher({ status: "running", launched: true, port: 1, health: up as never });

    const here = await failureOf(selfStartEngine({ cwd: project }, notRunning(), { env: on, launch }));
    expect(here.message).toBe("Summer Engine is not installed.");
    expect(here.recovery).toBe(SELF_START_RECOVERY.notInstalledHere);
    expect(here.recovery).toContain(DEV_COMMAND);

    _resetSelfStartForTests();
    const nowhere = await failureOf(selfStartEngine({ cwd: elsewhere }, notRunning(), { env: on, launch }));
    expect(nowhere.recovery).toBe(SELF_START_RECOVERY.notInstalled);
    expect(launch).not.toHaveBeenCalled();
  });

  it("installed but no project for this session: the dev command with a template", async () => {
    const launch = launcher({ status: "running", launched: true, port: 1, health: up as never });
    const error = await failureOf(selfStartEngine({ cwd: elsewhere }, notRunning(), { env: on, launch }));
    expect(error.recovery).toBe(SELF_START_RECOVERY.noProject);
    expect(error.recovery).toContain(`${DEV_COMMAND} 3d-basic`);
    expect(launch).not.toHaveBeenCalled();
  });

  it("another project open: names it and launches nothing", async () => {
    const instances = join(root, ".summer", "instances");
    mkdirSync(instances, { recursive: true });
    writeFileSync(
      join(instances, "other.json"),
      JSON.stringify({
        schemaVersion: 1,
        instanceId: "other",
        pid: process.pid,
        port: 6553,
        token: "t",
        resourceRoot: elsewhere,
        projectName: "Notes",
        heartbeatAt: Math.floor(Date.now() / 1000),
      })
    );
    healthMock.mockResolvedValue(up as never);
    const launch = launcher({ status: "running", launched: true, port: 1, health: up as never });

    const error = await failureOf(selfStartEngine({ cwd: project }, notRunning(), { env: on, launch }));

    expect(error.message).toBe("Summer Engine has another project open.");
    expect(error.recovery).toContain("Notes (");
    expect(error.recovery).toContain(`not ${project}`);
    expect(launch).not.toHaveBeenCalled();
  });

  it("SUMMER_AUTO_LAUNCH=0 launches nothing and says how to open the project", async () => {
    const launch = launcher({ status: "running", launched: true, port: 1, health: up as never });
    const error = await failureOf(selfStartEngine({ cwd: project }, notRunning(), { env: { SUMMER_AUTO_LAUNCH: "0" }, launch }));
    expect(error.recovery).toBe(SELF_START_RECOVERY.autoLaunchOff(project));
    expect(launch).not.toHaveBeenCalled();
  });

  it("a binary that fails to start says how to repair it", async () => {
    const launch = launcher({ status: "spawn_failed", binary: "/fake/Summer", code: "EACCES" });
    const error = await failureOf(selfStartEngine({ cwd: project }, notRunning(), { env: on, launch }));
    expect(error.recovery).toBe(SELF_START_RECOVERY.launchFailed("EACCES"));
  });
});
