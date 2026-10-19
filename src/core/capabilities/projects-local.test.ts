import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../engine-install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine-install.js")>();
  return { ...actual, findEngineBinary: vi.fn(() => "/Applications/Summer.app/Contents/MacOS/Summer") };
});

vi.mock("../engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine.js")>();
  return { ...actual, checkEngineHealth: vi.fn(async () => null) };
});

import type { EngineApiClient } from "../api-client.js";
import { findEngineBinary } from "../engine-install.js";
import type { LaunchEditorOptions } from "../engine-launch.js";
import { _resetSelfStartForTests, SELF_START_RECOVERY } from "../engine-self-start.js";
import { EngineNotRunningError } from "../error-codes.js";
import { setSummerDirForTests } from "../store.js";
import { EngineInstallError } from "../engine-install.js";
import { createLocalProject, defaultProjectParent, LocalProjectError, localProjectFailure, openLocalProject } from "./projects-local.js";

const findEngineBinaryMock = vi.mocked(findEngineBinary);
const up = { ok: true, engine: "summer", version: "0.9.9", port: 6551, instanceId: "fake-1" } as never;
const fakeClient = { getEngineVersion: () => "0.9.9" } as unknown as EngineApiClient;
/** A desktop session on every platform (Linux CI has no DISPLAY). */
const display = { DISPLAY: ":0" } as NodeJS.ProcessEnv;

let root = "";

beforeEach(() => {
  // A folder of the person's own, inside home (the test home), as an agent's session folder is.
  root = realpathSync(mkdtempSync(join(homedir(), "work-")));
  setSummerDirForTests(join(root, ".summer"));
  findEngineBinaryMock.mockReturnValue("/Applications/Summer.app/Contents/MacOS/Summer");
  _resetSelfStartForTests();
});

afterEach(() => {
  setSummerDirForTests(null);
  rmSync(root, { recursive: true, force: true });
});

async function failureOf<T extends Error>(run: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  const error = await run.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(type);
  return error as T;
}

describe("projects.create_local", () => {
  it("writes the 3d-basic starter to <name> in the session's folder and points at projects.open_local", async () => {
    const result = await createLocalProject({ name: "space-dodge" }, root);

    const dir = join(root, "space-dodge");
    expect(result).toEqual({ ok: true, projectPath: dir, template: "3d-basic", created: true, next: { op: "projects.open_local", input: { path: dir } } });
    expect(readFileSync(join(dir, "project.godot"), "utf8")).toContain('config/name="space-dodge"');
    expect(readFileSync(join(dir, "main.tscn"), "utf8")).toContain('type="WorldEnvironment"');
    expect(existsSync(join(dir, ".summer", "project.json"))).toBe(true);
  });

  it("a named template without a name goes to ./<template>; dir wins over both", async () => {
    expect(await createLocalProject({ template: "empty" }, root)).toMatchObject({ projectPath: join(root, "empty"), template: "empty" });
    const dir = join(root, "games", "here");
    expect(await createLocalProject({ dir: "games/here" }, root)).toMatchObject({ projectPath: dir, template: "3d-basic" });
  });

  it("a chat app's session folder (/, home, an app folder, outside home) puts the project in ~/Documents/Summer", () => {
    const home = join(root, "home");
    const summer = join(home, "Documents", "Summer");
    expect(defaultProjectParent(home, home)).toBe(summer);
    expect(defaultProjectParent("/", home)).toBe(summer);
    expect(defaultProjectParent(join(home, "AppData", "Local", "AnthropicClaude", "app-1.2.3"), home)).toBe(summer);
    expect(defaultProjectParent(join(home, "Library", "Application Support", "Claude"), home)).toBe(summer);
    expect(defaultProjectParent(join(root, "elsewhere"), join(root, "other-home"))).toBe(join(root, "other-home", "Documents", "Summer"));
    expect(defaultProjectParent(join(home, "code"), home)).toBe(join(home, "code"));
  });

  it("never inside another project: next to the session's project by default, refused when asked", async () => {
    const game = join(root, "first");
    mkdirSync(join(game, "scenes"), { recursive: true });
    writeFileSync(join(game, "project.godot"), "");
    expect(await createLocalProject({ name: "second" }, join(game, "scenes"))).toMatchObject({ projectPath: join(root, "second"), created: true });
    const inside = await failureOf(createLocalProject({ dir: join(game, "nested") }, root), LocalProjectError);
    expect(inside.message).toContain("is inside the project");
  });

  it("a second game with no name gets its own folder: my-game, then my-game-2", async () => {
    expect(await createLocalProject({}, root)).toMatchObject({ projectPath: join(root, "my-game"), created: true });
    expect(await createLocalProject({}, root)).toMatchObject({ projectPath: join(root, "my-game-2"), created: true });
    expect(await createLocalProject({ template: "empty" }, root)).toMatchObject({ projectPath: join(root, "empty") });
    expect(await createLocalProject({ template: "empty" }, root)).toMatchObject({ projectPath: join(root, "empty-2") });
  });

  it("expands ~ in dir and refuses . and .. as a name", async () => {
    expect(await createLocalProject({ dir: "~/games/tilde" }, root)).toMatchObject({ projectPath: join(homedir(), "games", "tilde") });
    expect((await failureOf(createLocalProject({ name: ".." }, root), LocalProjectError)).code).toBe("invalid_input");
  });

  it("leaves a folder that is already a project as it is", async () => {
    const dir = join(root, "game");
    mkdirSync(dir);
    writeFileSync(join(dir, "project.godot"), "; mine\n");
    expect(await createLocalProject({ dir }, root)).toMatchObject({ projectPath: dir, created: false, template: null });
    expect(readFileSync(join(dir, "project.godot"), "utf8")).toBe("; mine\n");
  });

  it("refuses a folder with other files, an unknown template and a path as name", async () => {
    const busy = join(root, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "notes.txt"), "hi");
    expect((await failureOf(createLocalProject({ dir: busy }, root), LocalProjectError)).code).toBe("invalid_input");
    const unknown = await failureOf(createLocalProject({ template: "no-such-template" }, root), LocalProjectError);
    expect(unknown.recovery).toContain("3d-basic");
    expect((await failureOf(createLocalProject({ name: "a/b" }, root), LocalProjectError)).recovery).toContain("dir");
  });
});

describe("projects.open_local", () => {
  function project(name: string): string {
    const dir = join(root, name);
    mkdirSync(join(dir, "scenes"), { recursive: true });
    writeFileSync(join(dir, "project.godot"), "");
    return dir;
  }

  it("opens the project in the background, binds the session to it and answers the next step", async () => {
    const game = project("game");
    const launch = vi.fn(async (_options: LaunchEditorOptions) => ({ status: "running" as const, launched: true, port: 6551, health: up }));
    const connect = vi.fn(async () => fakeClient);
    const onOpen = vi.fn();

    const result = await openLocalProject({ path: join(game, "scenes") }, { cwd: root }, { launch, connect, env: display }, onOpen, root);

    expect(result).toMatchObject({ ok: true, projectPath: game, engineVersion: "0.9.9", preview: { url: "http://localhost:5199", launchJson: join(root, ".claude", "launch.json") } });
    expect(result.next).toContain("summer_get_project_context");
    expect(result.next).toContain("http://localhost:5199");
    expect(JSON.parse(readFileSync(join(root, ".claude", "launch.json"), "utf8")).configurations[0]).toMatchObject({ name: "summer-preview", cwd: "game" });
    expect(launch.mock.calls[0][0]).toMatchObject({ projectPath: game, posture: "background" });
    expect(connect).toHaveBeenCalledWith({ cwd: game });
    expect(onOpen).toHaveBeenCalledWith(game, fakeClient);
  });

  it("no project: not_found, pointing at projects.create_local", async () => {
    const error = await failureOf(openLocalProject({ path: root }, { cwd: root }), LocalProjectError);
    expect(error.code).toBe("not_found");
    expect(error.recovery).toContain("projects.create_local");
  });

  it("an approved install that fails keeps its reason", async () => {
    const game = project("game");
    findEngineBinaryMock.mockReturnValue(null);
    const install = vi.fn(async () => {
      throw new EngineInstallError("disk_space", "Not enough free space on Macintosh HD. Free 2 GB, then call again.");
    });
    const error = await failureOf(openLocalProject({ path: game, install: true }, undefined, { install, waitMs: 20, env: display }), LocalProjectError);
    expect(localProjectFailure(error)).toMatchObject({ ok: false, code: "unavailable", reason: "disk_space", recovery: expect.stringContaining("Free 2 GB") });
  });

  it("never installs without install: true; with it, installs, says it is installing, then opens", async () => {
    const game = project("game");
    findEngineBinaryMock.mockReturnValue(null);
    const launch = vi.fn(async (_options: LaunchEditorOptions) => ({ status: "running" as const, launched: true, port: 6551, health: up }));
    const connect = vi.fn(async () => fakeClient);

    const refused = await failureOf(openLocalProject({ path: game }, undefined, { launch, connect, env: display }), EngineNotRunningError);
    expect(refused.recovery).toBe(SELF_START_RECOVERY.notInstalledHere);

    let finish: () => void = () => {};
    const install = vi.fn(
      async (options: { log?: (line: string) => void }) => {
        options.log?.("  40% (260.0MB)");
        await new Promise<void>((done) => (finish = done));
        findEngineBinaryMock.mockReturnValue("/Applications/Summer.app/Contents/MacOS/Summer");
        return { binary: "/x", version: "0.9.9", destination: "/x", alreadyInstalled: false };
      }
    );
    const installing = await failureOf(openLocalProject({ path: game, install: true }, undefined, { launch, connect, install, waitMs: 20, env: display }), EngineNotRunningError);
    expect(installing.message).toBe("Summer Engine is installing.");
    expect(installing.recovery).toBe(SELF_START_RECOVERY.installing("40% (260.0MB)"));
    expect(launch).not.toHaveBeenCalled();

    finish();
    const result = await openLocalProject({ path: game, install: true }, undefined, { launch, connect, install, waitMs: 20, env: display });
    expect(result.projectPath).toBe(game);
    expect(install).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
