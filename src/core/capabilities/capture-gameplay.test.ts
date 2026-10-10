import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineRun } from "./engine-run.js";
import { captureGameplay, captureProbeSource, importState, pngSize, probeSteps } from "./capture-gameplay.js";
import { BuildToolError } from "./summer-bundle.js";

/** A minimal PNG header (signature + IHDR) with the given size; enough for pngSize. */
function fakePng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

let root = "";
let project = "";
const calls: string[][] = [];

/** Fake engine run: plays the verify instance by writing frames and results.json into --summer-verify-out. */
function fakeRun(width = 1920, height = 1080, results?: Record<string, unknown>) {
  return async (_binary: string, args: string[]): Promise<EngineRun> => {
    calls.push(args);
    if (args.includes("--import")) {
      await mkdir(join(project, ".godot"), { recursive: true });
      return { code: 0, signal: null, timedOut: false, output: "" };
    }
    const out = args[args.indexOf("--summer-verify-out") + 1];
    expect(existsSync(args[args.indexOf("--summer-verify") + 1])).toBe(true);
    await writeFile(join(out, "shot-01.png"), fakePng(width, height));
    await writeFile(
      join(out, "results.json"),
      JSON.stringify(results ?? { shots: [{ file: "shot-01.png", width, height }], frame_warnings: [], errors_seen: [], finished: true })
    );
    return { code: 0, signal: null, timedOut: false, output: "engine output" };
  };
}

const deps = (run = fakeRun()) => ({ findBinary: () => "/fake/Summer", run, now: () => new Date("2026-10-09T12:00:00Z") });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-capture-test-"));
  project = join(root, "game");
  await mkdir(join(project, ".godot"), { recursive: true });
  await writeFile(join(project, "project.godot"), "config_version=5\n");
  await writeFile(join(project, "level.tscn"), "[gd_scene]\n");
  calls.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("captureGameplay", () => {
  it("runs the offscreen verify instance, never --headless, and returns real frame sizes", async () => {
    const result = await captureGameplay({ project, scene: "res://level.tscn" }, deps());
    const args = calls[0];
    expect(args).not.toContain("--headless");
    expect(args).toEqual(expect.arrayContaining(["--path", project, "--resolution", "1920x1080", "--scene", "res://level.tscn", "--summer-verify"]));
    expect(result.frames).toEqual([{ path: join(result.out, "shot-01.png"), width: 1920, height: 1080 }]);
    expect(result.out.startsWith(join(project, ".summer", "captures"))).toBe(true);
    expect(await readFile(join(project, ".summer", "captures", ".gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(join(result.out, "capture_probe.gd"))).toBe(false);
    expect(result.warnings).toBeUndefined();
    expect(result.imported).toBe(false);
  });

  it("runs offscreen explicitly and passes the game's own args after --", async () => {
    await captureGameplay({ project, args: ["--caper-autostart", "--caper-solo"] }, deps());
    const args = calls[0];
    expect(args).toContain("--summer-offscreen");
    expect(args).toEqual(expect.arrayContaining(["--max-fps", "60"]));
    expect(args.slice(-3)).toEqual(["--", "--caper-autostart", "--caper-solo"]);
    await captureGameplay({ project }, deps());
    expect(calls[1]).not.toContain("--");
  });

  it("writes the steps into the probe and gives them time", async () => {
    let probe = "";
    let maxSeconds = 0;
    const run = fakeRun();
    await captureGameplay(
      { project, waitSeconds: 1, steps: [{ press: "Play", timeoutSeconds: 20 }, { wait: 5000 }, { key: "Space" }, { shot: true }] },
      deps(async (binary, args, timeoutMs) => {
        probe = await readFile(args[args.indexOf("--summer-verify") + 1], "utf8");
        maxSeconds = Number(args[args.indexOf("--summer-verify-max") + 1]);
        return run(binary, args, timeoutMs);
      })
    );
    // Typed calls, no Variant reads: strict projects (warnings as errors) must load the probe.
    expect(probe).toContain('\tawait _press(0, "Play", 20.0)\n\tawait get_tree().create_timer(5.0, true).timeout\n\tawait _key_named(2, "Space", 100)\n\tawait _shot()\n');
    expect(probe).toContain("const SHOT_STEPS: bool = true");
    expect(probe).not.toMatch(/JSON\.parse|float\(step|\bvar \w+ =/);
    // The verify backstop counts frames: the run is capped at 60 fps and gets twice its planned time.
    expect(maxSeconds).toBeGreaterThanOrEqual(2 * (1 + 20 + 5));
    expect(maxSeconds).toBeLessThanOrEqual(240);
  });

  it("refuses malformed steps and args before starting anything", async () => {
    for (const steps of [[{}], [{ press: "Play", key: "Space" }], [{ click: [1] }], [{ shot: false }], [{ wait: -1 }], Array(11).fill({ shot: true })]) {
      await expect(captureGameplay({ project, steps: steps as never }, deps()), JSON.stringify(steps)).rejects.toMatchObject({ code: "capture_args_invalid" });
    }
    await expect(captureGameplay({ project, args: ["ok", "bad\nline"] }, deps())).rejects.toMatchObject({ code: "capture_args_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("warns when the project's stretch settings render another size", async () => {
    const result = await captureGameplay({ project, resolution: "1080x1920" }, deps(fakeRun(720, 1280)));
    expect(calls[0]).toEqual(expect.arrayContaining(["--resolution", "1080x1920"]));
    expect(result.frames[0]).toMatchObject({ width: 720, height: 1280 });
    expect(result.warnings?.[0]).toContain("not 1080x1920");
  });

  it("imports a never-opened project first", async () => {
    await rm(join(project, ".godot"), { recursive: true });
    const result = await captureGameplay({ project }, deps());
    expect(calls[0]).toEqual(expect.arrayContaining(["--headless", "--import"]));
    expect(calls[1]).toContain("--summer-verify");
    expect(result.imported).toBe(true);
  });

  it("names the engine's failure when no frame was saved", async () => {
    const run = fakeRun(1920, 1080, { ok: false, failure_reason: "no_main_scene", error: "No main scene", frames: [] });
    const error = await captureGameplay({ project }, deps(run)).catch((e) => e);
    expect(error).toBeInstanceOf(BuildToolError);
    expect(error.code).toBe("capture_failed");
    expect(error.message).toContain("no_main_scene");
    expect(error.recovery).toContain("main scene");
  });

  it("refuses bad arguments and a missing engine before starting anything", async () => {
    await expect(captureGameplay({ project, resolution: "big" }, deps())).rejects.toMatchObject({ code: "capture_args_invalid" });
    await expect(captureGameplay({ project, scene: "res://missing.tscn" }, deps())).rejects.toMatchObject({ code: "capture_args_invalid" });
    await expect(captureGameplay({ project, frames: 50 }, deps())).rejects.toMatchObject({ code: "capture_args_invalid" });
    await expect(captureGameplay({ project }, { ...deps(), findBinary: () => null })).rejects.toMatchObject({ code: "engine_not_installed" });
    expect(calls).toHaveLength(0);
  });
});

describe("import state", () => {
  const md5 = (bytes: string) => createHash("md5").update(bytes).digest("hex");
  async function imported(name: string, bytes: string) {
    await writeFile(join(project, name), bytes);
    await writeFile(join(project, `${name}.import`), `[remap]\n\nimporter="texture"\npath="res://.godot/imported/${name}-abc.ctex"\n`);
    await mkdir(join(project, ".godot", "imported"), { recursive: true });
    await writeFile(join(project, ".godot", "imported", `${name}-abc.md5`), `source_md5="${md5(bytes)}"\ndest_md5="x"\n`);
  }

  it("re-imports a new or changed asset, not one that is only touched", async () => {
    await imported("hero.png", "pixels");
    expect(importState(project).needed).toBe(false);
    // A copy or checkout touches the file without changing it.
    await utimes(join(project, "hero.png"), new Date(), new Date(Date.now() + 60_000));
    expect(importState(project).needed).toBe(false);
    await writeFile(join(project, "hero.png"), "new pixels");
    await utimes(join(project, "hero.png"), new Date(), new Date(Date.now() + 60_000));
    expect(importState(project)).toMatchObject({ needed: true, reason: "hero.png changed after the last import" });
    await imported("hero.png", "new pixels");
    await writeFile(join(project, "music.ogg"), "sound");
    expect(importState(project)).toMatchObject({ needed: true, reason: "music.ogg has not been imported" });
  });

  it("names Git LFS pointers and skips ignored folders", async () => {
    await mkdir(join(project, "art"), { recursive: true });
    await writeFile(join(project, "art", "big.glb"), "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9\n");
    await mkdir(join(project, "raw"), { recursive: true });
    await writeFile(join(project, "raw", ".gdignore"), "");
    await writeFile(join(project, "raw", "source.png"), "not imported on purpose");
    expect(importState(project)).toEqual({ needed: false, lfsPointers: [join("art", "big.glb")] });
  });
});

describe("probe and helpers", () => {
  it("reads PNG sizes and writes a self-contained probe", () => {
    expect(pngSize(fakePng(1080, 1920))).toEqual({ width: 1080, height: 1920 });
    expect(pngSize(Buffer.from("not a png at all, really not"))).toBeNull();
    const probe = captureProbeSource(3, 2, 1.5);
    expect(probe).toContain("\nextends Node\n");
    expect(probe).toContain("const FRAMES: int = 3");
    expect(probe).toContain("save_png");
    expect(probe).toContain("results.json");
    expect(probe).toContain("func _steps() -> void:\n\tpass\n");
    expect(probe).toContain("const SHOT_STEPS: bool = false");
  });

  it("turns steps into one shape with defaults", () => {
    expect(
      probeSteps([{ press: " Play " }, { key: "Space", holdMs: 300 }, { action: "jump" }, { click: [960, 540] }, { drag: { from: [0, 0], to: [10, 10] } }, { wait: 250 }, { shot: true }])
    ).toEqual([
      { type: "press", text: "Play", timeout: 10 },
      { type: "key", text: "Space", hold_ms: 300 },
      { type: "action", text: "jump", hold_ms: 100 },
      { type: "click", at: [960, 540] },
      { type: "drag", at: [0, 0], to: [10, 10], ms: 300 },
      { type: "wait", ms: 250 },
      { type: "shot" },
    ]);
  });
});
