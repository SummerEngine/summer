import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSummerDirForTests } from "../store.js";
import { writeSummerBundle } from "../../test-helpers/summer-bundle-fixture.js";
import { exportGame, readLastExport, runEngine } from "./export-game.js";
import { BuildToolError } from "./summer-bundle.js";

/**
 * The engine is a fake executable (a node script): it records its argv,
 * copies a prepared summer.games bundle to the output path (the last
 * argument) and exits with FAKE_ENGINE_EXIT. No real engine is started.
 */
const FAKE_ENGINE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_ENGINE_ARGS, JSON.stringify(args));
if (process.env.FAKE_ENGINE_SLEEP) setTimeout(() => {}, Number(process.env.FAKE_ENGINE_SLEEP));
else {
  console.log("Exporting summer.games");
  if (process.env.FAKE_ENGINE_EXIT === "0") fs.copyFileSync(process.env.FAKE_BUNDLE, args[args.length - 1]);
  else console.error(process.env.FAKE_ENGINE_ERROR || "ERROR: Export preset not found: " + args[5]);
  process.exitCode = Number(process.env.FAKE_ENGINE_EXIT);
}
`;

let root = "";
let project = "";
let engine = "";
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-export-test-"));
  project = join(root, "My Game");
  await mkdir(project);
  await writeFile(join(project, "project.godot"), "config_version=5\n");
  engine = join(root, "fake-engine");
  await writeFile(engine, FAKE_ENGINE);
  await chmod(engine, 0o755);
  await writeSummerBundle(join(root, "bundle.zip"));
  setSummerDirForTests(join(root, ".summer"));
  for (const name of ["FAKE_ENGINE_ARGS", "FAKE_BUNDLE", "FAKE_ENGINE_EXIT", "FAKE_ENGINE_SLEEP", "FAKE_ENGINE_ERROR"]) saved[name] = process.env[name];
  process.env.FAKE_ENGINE_ARGS = join(root, "args.json");
  process.env.FAKE_BUNDLE = join(root, "bundle.zip");
  process.env.FAKE_ENGINE_EXIT = "0";
  delete process.env.FAKE_ENGINE_SLEEP;
  delete process.env.FAKE_ENGINE_ERROR;
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

const lastArgs = async () => JSON.parse(await readFile(join(root, "args.json"), "utf8")) as string[];

async function failure(promise: Promise<unknown>): Promise<BuildToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BuildToolError) return error;
    throw error;
  }
  throw new Error("expected a BuildToolError");
}

describe("exportGame", () => {
  it("runs the engine headless with the summer.games preset and returns the bundle", async () => {
    const result = await exportGame({ project }, { findBinary: () => engine });
    const args = await lastArgs();
    expect(args.slice(0, 6)).toEqual(["--headless", "--summer-no-api", "--path", project, "--export-release", "summer.games"]);
    expect(args[6]).toBe(result.path);
    expect(result.path.startsWith(join(project, ".summer", "exports", "My Game-"))).toBe(true);
    expect(result.path.endsWith(".zip")).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      project,
      preset: "summer.games",
      debug: false,
      engine,
      bundle: { schema: "summer.bundle.v1", mainScene: "res://main.tscn", targetPlatforms: ["ios"], hosted: false, fileCount: 1 },
    });
    expect(result.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The export folder stays out of the editor's scan and out of git.
    expect(existsSync(join(project, ".summer", "exports", ".gdignore"))).toBe(true);
    expect(await readFile(join(project, ".summer", "exports", ".gitignore"), "utf8")).toBe("*\n");
    expect(await readLastExport()).toMatchObject({ path: result.path, project, sha256: result.sha256 });
  });

  it("exports debug builds to an explicit path", async () => {
    const out = join(root, "out", "game.zip");
    const result = await exportGame({ project, out, debug: true }, { findBinary: () => engine });
    expect((await lastArgs()).slice(4)).toEqual(["--export-debug", "summer.games", out]);
    expect(result.path).toBe(out);
  });

  it("reports the engine output when the export fails", async () => {
    process.env.FAKE_ENGINE_EXIT = "1";
    const error = await failure(exportGame({ project }, { findBinary: () => engine }));
    expect(error.code).toBe("export_failed");
    expect(String(error.detail?.output)).toContain("Export preset not found: summer.games");
    expect(error.message).toContain("did not export the game (exit 1): Export preset not found: summer.games");
    expect(error.recovery).toContain("update Summer Engine to 0.7.0+");
  });

  it("puts the engine's own ERROR lines in the message, not the preset hint", async () => {
    process.env.FAKE_ENGINE_EXIT = "1";
    process.env.FAKE_ENGINE_ERROR = [
      "\u001b[91mERROR: summer.games: The pack's compositionPath res://game/net/caper_composition.tres is in the source graph's authority_engine domain, which the client pack leaves out.\u001b[0m",
      "   at: add_message (./editor/export/editor_export_platform.h:276)",
      'ERROR: Project export for preset "summer.games" failed.',
    ].join("\n");
    const error = await failure(exportGame({ project }, { findBinary: () => engine }));
    expect(error.message).toContain("compositionPath res://game/net/caper_composition.tres is in the source graph's authority_engine domain");
    expect(error.message).toContain('| Project export for preset "summer.games" failed.');
    expect(error.recovery).toContain("source-domains.json");
    expect(error.recovery).not.toContain("predates");
    expect(error.detail?.errors).toEqual([
      "ERROR: summer.games: The pack's compositionPath res://game/net/caper_composition.tres is in the source graph's authority_engine domain, which the client pack leaves out.",
      'ERROR: Project export for preset "summer.games" failed.',
    ]);
  });

  it("reports the project files the export changed", async () => {
    const touch = async () => {
      await writeFile(join(project, "project.godot.bak"), "config_version=5\n");
      await writeFile(join(project, "project.godot"), "config_version=5\n[application]\n");
      return { code: 0, signal: null, timedOut: false, output: "" };
    };
    const out = join(project, "game.zip");
    const result = await exportGame(
      { project, out, targets: ["ios"] },
      {
        findBinary: () => engine,
        run: async (binary, args, timeoutMs) => {
          const run = await runEngine(binary, args, timeoutMs);
          await touch();
          return run;
        },
      }
    );
    expect(result.projectChanges).toEqual([
      { file: "export_presets.cfg", change: "created" },
      { file: "project.godot", change: "modified" },
      { file: "project.godot.bak", change: "created" },
    ]);
    expect(result.warnings?.[0]).toContain("rewrote project.godot");
  });

  it("stops an engine that runs past the timeout", async () => {
    process.env.FAKE_ENGINE_SLEEP = "20000";
    const run = await runEngine(engine, ["--headless"], 300);
    expect(run.timedOut).toBe(true);
    const error = await failure(
      exportGame({ project }, { findBinary: () => engine, run: async () => ({ code: null, signal: "SIGTERM", timedOut: true, output: "importing" }) })
    );
    expect(error.code).toBe("export_timeout");
  });

  it("says when the engine is not installed or the folder is not a project", async () => {
    expect((await failure(exportGame({ project }, { findBinary: () => null }))).code).toBe("engine_not_installed");
    expect((await failure(exportGame({ project: root }, { findBinary: () => engine }))).code).toBe("project_not_found");
    expect((await failure(exportGame({ project, out: join(root, "game.pck") }, { findBinary: () => engine }))).code).toBe(
      "export_path_invalid"
    );
  });
});
