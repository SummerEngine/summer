import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { LaunchLockBusyError, type LaunchEditorOptions, type LaunchEditorResult } from "./engine-launch.js";
import {
  _resetRecentForTests,
  _resetSelfStartForTests,
  DEV_COMMAND,
  hasNoDisplay,
  keepSaying,
  OPEN_PROGRESS_EVERY_MS,
  openProjectInEditor,
  selfStartEngine,
  SELF_START_RECOVERY,
  SELF_START_WAIT_MS,
  sessionProject,
  SWITCH_PROJECT_OP,
  SWITCH_REGISTER_MS,
} from "./engine-self-start.js";
import { EngineNotRunningError } from "./error-codes.js";
import { setSummerDirForTests } from "./store.js";

const findEngineBinaryMock = vi.mocked(findEngineBinary);
const healthMock = vi.mocked(checkEngineHealth);
const up = { ok: true, engine: "summer", version: "0.9.9", port: 6551, instanceId: "fake-1" };
const notRunning = () => new EngineNotRunningError("Summer Engine is not running.", "no api-token found");
const fakeClient = { fake: true } as unknown as EngineApiClient;
/** Auto-launch on, in a desktop session on every platform (Linux CI has no DISPLAY). */
const on = { SUMMER_AUTO_LAUNCH: "1", DISPLAY: ":0" } as NodeJS.ProcessEnv;

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

  it("a registered editor that does not answer is busy: no launch, call again", async () => {
    const launch = launcher({ status: "running", launched: true, port: 1, health: up as never });
    const busy = new EngineNotRunningError("Summer Engine is not responding on port 6551.", "Summer Engine instance abc is not responding on port 6551.");
    const error = await failureOf(selfStartEngine({ cwd: project }, busy, { env: on, launch }));
    expect(error.recovery).toBe(SELF_START_RECOVERY.busy);
    expect(launch).not.toHaveBeenCalled();
  });

  it("Linux with no display answers at once instead of launching a window that cannot open", async () => {
    const launch = launcher({ status: "running", launched: true, port: 1, health: up as never });
    const error = await failureOf(selfStartEngine({ cwd: project }, notRunning(), { env: { SUMMER_AUTO_LAUNCH: "1" }, launch }));
    if (process.platform === "linux") {
      expect(error.recovery).toBe(SELF_START_RECOVERY.noDisplay);
      expect(launch).not.toHaveBeenCalled();
    }
    expect(hasNoDisplay({}, "linux")).toBe(true);
    expect(hasNoDisplay({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(false);
    expect(hasNoDisplay({}, "darwin")).toBe(false);
  });

  it("only a busy launch lock means starting; another launch failure says so", async () => {
    const lockBusy = vi.fn(async (_options: LaunchEditorOptions): Promise<LaunchEditorResult> => {
      throw new LaunchLockBusyError();
    });
    expect((await failureOf(selfStartEngine({ cwd: project }, notRunning(), { env: on, launch: lockBusy }))).recovery).toBe(SELF_START_RECOVERY.launchBusy);
    _resetSelfStartForTests();
    const broken = vi.fn(async (_options: LaunchEditorOptions): Promise<LaunchEditorResult> => {
      throw new Error("EACCES: ~/.summer");
    });
    expect((await failureOf(selfStartEngine({ cwd: project }, notRunning(), { env: on, launch: broken }))).recovery).toBe(SELF_START_RECOVERY.launchFailed("EACCES: ~/.summer"));
  });

  it("a launch whose editor died is not waited on: the next call launches again", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const launch = launcher({ status: "starting", binary: "/fake/Summer", pid: 2 ** 30 });
    const connect = vi.fn(async (): Promise<EngineApiClient> => {
      throw new Error("not yet");
    });
    await failureOf(selfStartEngine({ projectPath: project }, notRunning(), { env: on, launch, connect, now, waitMs: 0 }));
    clock += 30_000;
    await failureOf(selfStartEngine({ projectPath: project }, notRunning(), { env: on, launch, connect, now, waitMs: 0 }));
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("with no project in the agent's folder, the project the last summer dev opened from it is the session's while that editor runs", async () => {
    const record = join(root, ".summer", "last-launch.json");
    const write = (value: Record<string, unknown>) => writeFileSync(record, JSON.stringify({ projectPath: project, pid: process.pid, at: Date.now(), ...value }));
    mkdirSync(join(root, ".summer"), { recursive: true });
    write({ cwd: elsewhere });
    expect(await sessionProject({ cwd: elsewhere })).toBe(project);
    // A project below the session's folder needs no matching cwd; another session's folder never adopts it.
    write({ cwd: "/somewhere/else" });
    expect(await sessionProject({ cwd: root })).toBe(project);
    expect(await sessionProject({ cwd: elsewhere })).toBeNull();
    // A dead editor, an old record or a deleted project never block or misdirect: the stale record is removed.
    write({ cwd: elsewhere, pid: 2 ** 30 });
    expect(await sessionProject({ cwd: elsewhere })).toBeNull();
    expect(existsSync(record)).toBe(false);
    write({ cwd: elsewhere, at: Date.now() - 11 * 60_000 });
    expect(await sessionProject({ cwd: elsewhere })).toBeNull();
    write({ cwd: elsewhere, projectPath: join(root, "gone") });
    expect(await sessionProject({ cwd: elsewhere })).toBeNull();
  });

  it("while an approved install runs, other engine tools say installing instead of asking again", async () => {
    findEngineBinaryMock.mockReturnValue(null);
    let finish: () => void = () => {};
    const install = vi.fn(async (options: { log?: (line: string) => void }) => {
      options.log?.("  20% (130.0MB)");
      await new Promise<void>((done) => (finish = done));
      return { binary: "/x", version: "0.9.9", destination: "/x", alreadyInstalled: false };
    });
    const launch = launcher({ status: "running", launched: true, port: 1, health: up as never });
    await failureOf(openProjectInEditor(project, { cwd: project }, { install: true }, { env: on, launch, install, waitMs: 0 }));
    _resetRecentForTests();
    const other = await failureOf(selfStartEngine({ cwd: elsewhere }, notRunning(), { env: on, launch }));
    expect(other.recovery).toBe(SELF_START_RECOVERY.installing("20% (130.0MB)"));
    finish();
  });

  it("a SUMMER_BIN that names nothing is never answered with an install", async () => {
    findEngineBinaryMock.mockReturnValue(null);
    const install = vi.fn();
    const error = await failureOf(
      openProjectInEditor(project, { cwd: project }, { install: true }, { env: { ...on, SUMMER_BIN: join(root, "missing", "Summer") }, install: install as never })
    );
    expect(error.recovery).toContain("nothing exists there");
    expect(install).not.toHaveBeenCalled();
  });

  it("a binary that fails to start says how to repair it", async () => {
    const launch = launcher({ status: "spawn_failed", binary: "/fake/Summer", code: "EACCES" });
    const error = await failureOf(selfStartEngine({ cwd: project }, notRunning(), { env: on, launch }));
    expect(error.recovery).toBe(SELF_START_RECOVERY.launchFailed("EACCES"));
    // An editor that closed cleanly is not a broken install: no reinstall advice.
    _resetSelfStartForTests();
    const closed = launcher({ status: "spawn_failed", binary: "/fake/Summer", code: "exited with code 0" });
    const early = await failureOf(selfStartEngine({ cwd: project }, notRunning(), { env: on, launch: closed }));
    expect(early.recovery).toBe(SELF_START_RECOVERY.closedEarly(project));
    expect(early.recovery).not.toContain("install");
  });
});

describe("projects.open_local switches an editor that has another game open (J16.1)", () => {
  function register(id: string, resourceRoot: string, port: number): void {
    const instances = join(root, ".summer", "instances");
    mkdirSync(instances, { recursive: true });
    writeFileSync(
      join(instances, `${id}.json`),
      JSON.stringify({ schemaVersion: 1, instanceId: id, pid: process.pid, port, token: "t", resourceRoot, projectName: id, heartbeatAt: Math.floor(Date.now() / 1000) })
    );
  }

  /** A fake engine: the open editor runs the switch op; the next editor registers when `registers`. */
  function fakeEngine(opAnswer: unknown, registers: boolean) {
    const ops: unknown[] = [];
    const connect = vi.fn(async (selection: { instanceId?: string; projectPath?: string } | undefined) => {
      if (selection?.instanceId === "other") {
        return {
          executeOps: async (sent: unknown[]) => {
            ops.push(...sent);
            // The new editor boots first and registers a moment after the op returns.
            if (registers) setTimeout(() => register("next", project, 6554), 300);
            return opAnswer;
          },
        } as unknown as EngineApiClient;
      }
      if (selection?.projectPath === project) return fakeClient;
      throw new Error("no editor");
    });
    return { ops, connect };
  }

  it("asks the running editor to switch, says so at once, waits for the new editor in the registry, and connects to it", async () => {
    register("other", elsewhere, 6553);
    healthMock.mockResolvedValue(up as never);
    const launch = launcher({ status: "running", launched: true, port: 1, health: up as never });
    const engine = fakeEngine({ results: [{ ok: true }] }, true);
    const progress: Array<{ message: string; at: number }> = [];

    const started = Date.now();
    const client = await openProjectInEditor(
      project,
      { cwd: project },
      { switchOpen: true },
      { env: on, launch, connect: engine.connect, progress: (message) => progress.push({ message, at: Date.now() - started }) }
    );

    expect(client).toBe(fakeClient);
    expect(engine.ops).toEqual([{ op: SWITCH_PROJECT_OP, path: project }]);
    expect(launch).not.toHaveBeenCalled();
    // J16.5: progress within 1 s, before the new editor is there.
    expect(progress[0]?.message).toBe("Opening game…");
    expect(progress[0]!.at).toBeLessThan(1_000);
  });

  it("waits the full boot of the new editor (about 14 s on CI, J17) within the 30 s switch wait", () => {
    expect(SWITCH_REGISTER_MS).toBe(30_000);
    expect(SWITCH_REGISTER_MS).toBeLessThan(SELF_START_WAIT_MS);
  });

  it("says Opening <game>… at once and every few seconds until the game is open", () => {
    vi.useFakeTimers();
    try {
      const said: string[] = [];
      const stop = keepSaying((message) => said.push(message), "Opening game…");
      expect(said).toEqual(["Opening game…"]);
      vi.advanceTimersByTime(OPEN_PROGRESS_EVERY_MS * 4 + 10);
      expect(said).toHaveLength(5);
      stop();
      vi.advanceTimersByTime(OPEN_PROGRESS_EVERY_MS * 3);
      expect(said).toHaveLength(5);
      expect(OPEN_PROGRESS_EVERY_MS).toBeLessThanOrEqual(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an editor without the switch operation keeps the old answer and names the open game", async () => {
    register("other", elsewhere, 6553);
    healthMock.mockResolvedValue(up as never);
    const engine = fakeEngine({ results: [{ ok: false, error: "Unknown op: SwitchProject", failure_reason: "engine_lacks_op" }] }, false);

    const error = await failureOf(openProjectInEditor(project, { cwd: project }, { switchOpen: true }, { env: on, connect: engine.connect }));

    expect(error.message).toBe("Summer Engine has another project open.");
    expect(error.recovery).toContain("cannot switch games");
  });

  it("a new editor that does not register within the switch wait is reported as switching, call again", async () => {
    register("other", elsewhere, 6553);
    healthMock.mockResolvedValue(up as never);
    const engine = fakeEngine({ results: [{ ok: true }] }, false);

    const error = await failureOf(
      openProjectInEditor(project, { cwd: project }, { switchOpen: true }, { env: on, connect: engine.connect, switchWaitMs: 300 })
    );

    expect(error.message).toBe("Summer Engine is switching to the project.");
    expect(error.recovery).toContain("Call again");
  });

  it("without switchOpen (any other tool) the open game is never switched", async () => {
    register("other", elsewhere, 6553);
    healthMock.mockResolvedValue(up as never);
    const engine = fakeEngine({ results: [{ ok: true }] }, true);

    const error = await failureOf(openProjectInEditor(project, { cwd: project }, {}, { env: on, connect: engine.connect }));

    expect(error.message).toBe("Summer Engine has another project open.");
    expect(engine.ops).toEqual([]);
  });
});
