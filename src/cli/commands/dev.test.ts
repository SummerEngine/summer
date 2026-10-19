import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../core/engine-install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/engine-install.js")>();
  return { ...actual, findEngineBinary: vi.fn(() => null) };
});

vi.mock("../../core/cli-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/cli-usage.js")>();
  return { ...actual, noteCliError: vi.fn() };
});

import { noteCliError } from "../../core/cli-usage.js";
import { EngineInstallError, findEngineBinary } from "../../core/engine-install.js";
import type { LaunchEditorOptions, LaunchEditorResult } from "../../core/engine-launch.js";
import { setSummerDirForTests } from "../../core/store.js";
import { getTemplateRegistry } from "../../core/templates.js";
import { connectedLine, planDev, runDev } from "./dev.js";

const findEngineBinaryMock = vi.mocked(findEngineBinary);
const noteCliErrorMock = vi.mocked(noteCliError);
const entries = getTemplateRegistry();
const up = { ok: true, engine: "summer", version: "0.9.9", port: 6551, instanceId: "fake-1" } as never;
const savedBin = process.env.SUMMER_BIN;

let root = "";
let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "summer-dev-")));
  setSummerDirForTests(join(root, ".summer"));
  logs = [];
  errors = [];
  findEngineBinaryMock.mockReset();
  findEngineBinaryMock.mockReturnValue("/Applications/Summer.app/Contents/MacOS/Summer");
  noteCliErrorMock.mockReset();
  delete process.env.SUMMER_BIN;
});

afterEach(() => {
  if (savedBin === undefined) delete process.env.SUMMER_BIN;
  else process.env.SUMMER_BIN = savedBin;
  setSummerDirForTests(null);
  rmSync(root, { recursive: true, force: true });
});

const io = { log: (line: string) => logs.push(line), error: (line: string) => errors.push(line) };
function launcher(result: LaunchEditorResult) {
  return vi.fn(async (_options: LaunchEditorOptions) => result);
}
const noInstall = vi.fn(async () => {
  throw new Error("install must not run");
});

function folder(name: string, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

describe("planDev: where `summer dev` works", () => {
  it("creates the built-in 3d-basic starter in an empty folder, or one with only dotfiles", () => {
    const empty = folder("empty");
    expect(planDev([], empty, entries)).toMatchObject({ kind: "create", dir: empty, entry: { slug: "3d-basic" } });
    const dotfiles = folder("dotfiles", { ".gitignore": "", ".mcp.json": "{}" });
    expect(planDev(["."], dotfiles, entries)).toMatchObject({ kind: "create", dir: dotfiles, entry: { slug: "3d-basic" } });
  });

  it("opens a folder that already holds project.godot, and says when a named template was not applied", () => {
    const project = folder("game", { "project.godot": "" });
    expect(planDev([], project, entries)).toEqual({ kind: "open", dir: project });
    expect(planDev(["."], project, entries)).toEqual({ kind: "open", dir: project });
    const named = planDev(["empty", project], root, entries);
    expect(named).toMatchObject({ kind: "open", dir: project });
    expect((named as { note?: string }).note).toContain("empty was not applied");
  });

  it("a folder with other files gets ./my-game (or ./<template>), and re-running opens it", () => {
    const busy = folder("busy", { "notes.txt": "hi" });
    expect(planDev([], busy, entries)).toMatchObject({ kind: "create", dir: join(busy, "my-game") });
    expect(planDev(["empty"], busy, entries)).toMatchObject({ kind: "create", dir: join(busy, "empty"), entry: { slug: "empty" } });
    folder("busy/my-game", { "project.godot": "" });
    expect(planDev([], busy, entries)).toEqual({ kind: "open", dir: join(busy, "my-game") });
  });

  it("one argument: a folder when it is a path or exists, a template when one matches, else a new folder name", () => {
    expect(planDev(["./space"], root, entries)).toMatchObject({ kind: "create", dir: join(root, "space"), entry: { slug: "3d-basic" } });
    expect(planDev(["empty"], root, entries)).toMatchObject({ kind: "create", entry: { slug: "empty" } });
    expect(planDev(["space-game"], root, entries)).toMatchObject({ kind: "create", dir: join(root, "space-game"), entry: { slug: "3d-basic" } });
  });

  it("refuses a folder with files but no project, and an ambiguous or unknown template", () => {
    const busy = folder("busy", { "notes.txt": "hi" });
    expect(planDev(["."], busy, entries)).toMatchObject({ kind: "error", code: "not_empty" });
    expect(planDev(["3d-fps", "x"], root, entries)).toMatchObject({ kind: "error", code: "template" });
    expect(planDev(["no-such-template", "x"], root, entries)).toMatchObject({ kind: "error", code: "template" });
  });
});

describe("runDev: install, create, open, wait", () => {
  it("creates the starter in the current folder, opens it in the background and prints the connected line", async () => {
    const here = folder("here", { ".git": "" });
    const launch = launcher({ status: "running", launched: true, port: 6551, health: up });

    const code = await runDev([], { background: true }, { cwd: here, install: noInstall, launch, ...io });

    expect(code).toBe(0);
    expect(noInstall).not.toHaveBeenCalled();
    expect(readFileSync(join(here, "main.tscn"), "utf8")).toContain('type="WorldEnvironment"');
    expect(readFileSync(join(here, "project.godot"), "utf8")).toContain('config/name="here"');
    expect(existsSync(join(here, ".summer", "project.json"))).toBe(true);
    expect(launch.mock.calls[0][0]).toMatchObject({ projectPath: here, posture: "background", waitMs: 180_000, progressEveryMs: 10_000 });
    expect(logs.at(-1)).toBe(connectedLine("0.9.9", here));
    expect(logs.at(-1)).toContain("summer_get_project_context");
  });

  it("installs the engine first when none is installed", async () => {
    findEngineBinaryMock.mockReturnValue(null);
    const install = vi.fn(async () => ({ binary: "/x/Summer", version: "0.9.9", destination: "/x", alreadyInstalled: false }));
    const launch = launcher({ status: "running", launched: true, port: 6551, health: up });

    expect(await runDev([folder("new")], {}, { cwd: root, install, launch, ...io })).toBe(0);
    expect(install).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("Installing it");
  });

  it("a failed install stops before any project is written, with its reason in the usage line", async () => {
    findEngineBinaryMock.mockReturnValue(null);
    const install = vi.fn(async () => {
      throw new EngineInstallError("disk_space", "Not enough free space on Macintosh HD.");
    });
    const launch = launcher({ status: "running", launched: true, port: 6551, health: up });
    const target = join(root, "never");

    expect(await runDev([target], {}, { cwd: root, install, launch, ...io })).toBe(1);
    expect(noteCliErrorMock).toHaveBeenCalledWith("disk_space");
    expect(errors.join("\n")).toContain("Not enough free space");
    expect(existsSync(join(target, "project.godot"))).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it("a named build that does not exist is an error, never an install", async () => {
    process.env.SUMMER_BIN = join(root, "missing", "Summer");
    expect(await runDev([folder("x")], {}, { cwd: root, install: noInstall, ...io })).toBe(1);
    expect(noteCliErrorMock).toHaveBeenCalledWith("no_binary");
    expect(noInstall).not.toHaveBeenCalled();
  });

  it("each way the editor does not come up has its own code", async () => {
    const project = folder("game", { "project.godot": "" });
    const cases: Array<[LaunchEditorResult, string]> = [
      [{ status: "starting", binary: "/x" }, "timeout"],
      [{ status: "other_project", project: "Other (/o)" }, "other_project"],
      [{ status: "spawn_failed", binary: "/x", code: "EACCES" }, "launch"],
    ];
    for (const [result, code] of cases) {
      noteCliErrorMock.mockReset();
      expect(await runDev([project], {}, { cwd: root, install: noInstall, launch: launcher(result), ...io })).toBe(1);
      expect(noteCliErrorMock).toHaveBeenCalledWith(code);
    }
    expect(errors.join("\n")).toContain("still starting");
  });
});

describe.skipIf(process.platform === "win32")("runDev end to end with a fake engine binary and health server", () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
  });

  it("launches the fake engine on the new project and waits for its API", async () => {
    const argsFile = join(root, "engine-args.txt");
    const engine = join(root, "bin", "Summer");
    mkdirSync(join(root, "bin"));
    // --help lists the background flag (the launch probe); a real launch records its argv.
    writeFileSync(engine, `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--summer-background"; exit 0; fi\necho "$@" > "${argsFile}"\n`, { mode: 0o755 });
    process.env.SUMMER_BIN = engine;

    // The editor's API answers once the engine has started.
    server = createServer((_req, res) => {
      if (!existsSync(argsFile)) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, engine: "summer", version: "0.9.9", instanceId: "fake-1" }));
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
    const port = (server.address() as { port: number }).port;
    mkdirSync(join(root, ".summer"), { recursive: true });
    writeFileSync(join(root, ".summer", "api-port"), String(port));

    const target = join(root, "fresh");
    const code = await runDev([target], { background: true }, { cwd: root, install: noInstall, waitMs: 30_000, ...io });

    expect(errors).toEqual([]);
    expect(code).toBe(0);
    // --summer-background too, unless the 5 s --help probe timed out on a busy machine (run.test.ts covers the flag).
    expect(readFileSync(argsFile, "utf8").trim()).toMatch(new RegExp(`^--path ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --editor( --summer-background)?$`));
    expect(existsSync(join(target, "main.tscn"))).toBe(true);
    expect(logs.at(-1)).toBe(connectedLine("0.9.9", target));
  });
});
