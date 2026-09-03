import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * assets/autopilot/probe_base.gd is a VENDORED COPY of the engine's canonical
 * modules/1summer_engine/verify/summer_probe_base.gd, so that `summer create`
 * can scaffold a runnable probe into a project that has no engine checkout.
 *
 * It has already drifted once: the vendored copy predated the fix for
 * Engine.get_frames_drawn() being 0 forever under --headless, so settle() would
 * spin until the probe budget killed the run. Shipping a stale base means
 * shipping a hang. This test is the tripwire.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vendored = join(packageRoot, "assets", "autopilot", "probe_base.gd");
// Engine checkout: $SUMMER_ENGINE_REPO, else the `summerengine` sibling. This
// package is not inside the engine monorepo, so the old ../../modules path
// never existed and the tripwire silently never fired.
const engineRepo = process.env.SUMMER_ENGINE_REPO
  ? resolve(process.env.SUMMER_ENGINE_REPO)
  : resolve(packageRoot, "..", "summerengine");
const canonical = join(engineRepo, "modules", "1summer_engine", "verify", "summer_probe_base.gd");
const canonicalFound = existsSync(canonical);
const checkCanonical = canonicalFound ? it : it.skip;

describe("repo-lint: autopilot scaffold", () => {
  it("ships every file the scaffold needs", () => {
    for (const name of ["autopilot.gd", "probe_base.gd", "run.sh", "README.md"]) {
      expect(existsSync(join(packageRoot, "assets", "autopilot", name)), name).toBe(true);
    }
  });

  it("runs the verify instance with a renderer and the import pre-pass without one", () => {
    const runner = readFileSync(join(packageRoot, "assets", "autopilot", "run.sh"), "utf-8");
    // Comments are allowed to mention the flags — that is where we explain them.
    // Only executable lines matter.
    const code = runner.split("\n").filter((line) => !line.trim().startsWith("#"));
    // --headless is fine for `--import` (no pixels needed to build .godot/ caches)
    // and fatal for `--summer-verify` (no renderer, so save_frame() gets nothing).
    for (const line of code.filter((l) => l.includes("--headless"))) {
      expect(line, line).toMatch(/--import/);
    }
    for (const line of code.filter((l) => l.includes("--summer-verify "))) {
      expect(line, line).not.toMatch(/--headless/);
    }
    expect(code.join("\n")).toMatch(/--summer-verify/);
    expect(code.join("\n")).toMatch(/--headless --import/);
    // Agent-driven runs must not arm the crash handler: it popen()s atos from
    // inside a signal handler, turning a clean failure into a hang.
    expect(code.join("\n")).toMatch(/--disable-crash-handler/);
    // The pre-pass is bounded and skippable, never unconditional.
    expect(code.join("\n")).toMatch(/IMPORT_MAX_SECONDS/);
    expect(code.join("\n")).toMatch(/global_script_class_cache\.cfg/);
    expect(code.join("\n")).toMatch(/--reimport/);
  });

  it("ships a smoke test by default: no waypoints, so a fresh project is not asked to walk", () => {
    const probe = readFileSync(join(packageRoot, "assets", "autopilot", "autopilot.gd"), "utf-8");
    expect(probe).toMatch(/^const WAYPOINTS: Array = \[\]$/m);
    expect(probe).toMatch(/report\("smoke", true\)/);
    expect(probe).toMatch(/report\("player_found_by"/);
  });

  checkCanonical(
    `keeps probe_base.gd byte-identical to the engine's canonical copy${
      canonicalFound ? "" : ` (SKIPPED: no engine checkout at ${canonical}; set SUMMER_ENGINE_REPO)`
    }`,
    () => {
      expect(readFileSync(vendored, "utf-8")).toBe(readFileSync(canonical, "utf-8"));
    }
  );
});

/**
 * run.sh's verdict is the Python block it feeds results.json to. Run THAT code, not a
 * re-implementation, against fixtures shaped like the engine writes them: every
 * errors_seen entry is `LEVEL|file:line|function|code|rationale` from
 * SummerVerifyLogger::log_error, LEVEL one of ERROR / WARNING / SCRIPT ERROR /
 * SHADER ERROR. Only WARNING may pass.
 */
describe("run.sh verdict (the Python gate, executed on fixtures)", () => {
  const runner = readFileSync(join(packageRoot, "assets", "autopilot", "run.sh"), "utf-8");
  const match = runner.match(/python3 - "\$OUT\/results\.json" <<'PY'\n([\s\S]*?)\nPY\n/);
  const gate = match?.[1] ?? "";
  const havePython = spawnSync("python3", ["--version"]).status === 0;
  const withPython = havePython ? it : it.skip;
  const scratch = mkdtempSync(join(tmpdir(), "summer-gate-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const WARN = "WARNING|scene/resources/resource_format_text.cpp:516|load|res://main.tscn:3 - ext_resource, invalid UID: uid://x - using text path instead: res://a.gd|";
  const ERR = 'ERROR|scene/main/node.cpp:1976|get_node|Method/function failed. Returning: nullptr|Node not found: "%HeartsContainer" (relative to "/root/Room01/HUD").';
  const SCRIPT = 'SCRIPT ERROR|res://scripts/main_menu.gd:9|GDScript::reload|Parse Error: Identifier "MenuStyle" not declared in the current scope.|';
  const SHADER = "SHADER ERROR|res://fx.gdshader:4|compile|bad shader|";

  function run(fixture: Record<string, unknown>, name: string) {
    const file = join(scratch, `${name}.json`);
    writeFileSync(file, JSON.stringify(fixture, null, 2));
    const r = spawnSync("python3", ["-", file], { input: gate, encoding: "utf-8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }
  const base = { reports: {}, frames: ["00_start.jpg", "01_running.jpg"], frame_warnings: [], duration_ms: 1200, finished: true };

  it("extracts a non-empty gate from run.sh", () => {
    expect(gate).toContain("errors_seen");
    expect(gate).toContain('== "WARNING"');
  });

  withPython("passes a smoke run whose only engine output is WARNINGs, and counts them", () => {
    const r = run({ ...base, reports: { smoke: true, player_found_by: "none" }, errors_seen: [WARN, WARN] }, "warn-only");
    expect(r.code).toBe(0);
    expect(r.err).toContain("WARNINGS: 2 engine warning(s)");
    expect(r.out).toMatch(/^PASSED: smoke test: booted and ran, 2 frame\(s\), 0 errors, 2 warning\(s\)$/m);
  });

  withPython("fails on ERROR, SCRIPT ERROR and any level it does not know", () => {
    for (const [name, line] of [["error", ERR], ["script", SCRIPT], ["shader", SHADER], ["unknown", "UNKNOWN ERROR|x|y|z|"]] as const) {
      const r = run({ ...base, reports: { smoke: true }, errors_seen: [WARN, line] }, `level-${name}`);
      expect(r.code, name).toBe(1);
      expect(r.err, name).toContain("FAILED: 1 engine error(s) during the run");
      expect(r.err, name).toContain(line.slice(0, 40));
      expect(r.err, name).toContain("WARNINGS: 1 engine warning(s)"); // still shown, before the verdict
    }
  });

  withPython("fails when the probe never finished, whatever else is in the file", () => {
    const r = run({ ...base, finished: false, reports: { smoke: true }, errors_seen: [] }, "unfinished");
    expect(r.code).toBe(1);
    expect(r.err).toContain("FAILED: probe did not finish");
  });

  withPython("fails on reports.error and on a missed waypoint; passes when every waypoint was reached", () => {
    const err = run({ ...base, reports: { error: "waypoints are configured but no player was found at 'Player' (or by auto-detect)" }, errors_seen: [] }, "reports-error");
    expect(err.code).toBe(1);
    expect(err.err).toContain("FAILED: waypoints are configured but no player was found");
    expect(err.err).toContain("Edit the CONFIG block");

    const missed = run({ ...base, reports: { waypoint_0_reached: true, waypoint_1_reached: false, failed_at_waypoint: 1 }, errors_seen: [] }, "missed");
    expect(missed.code).toBe(1);
    expect(missed.err).toContain("FAILED: waypoints not reached: waypoint_1_reached");

    const ok = run({ ...base, frames: ["00_start.jpg", "01_waypoint_0.jpg", "02_waypoint_1.jpg"], reports: { waypoint_0_reached: true, waypoint_1_reached: true }, errors_seen: [] }, "reached");
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^PASSED: 2 waypoint\(s\) reached, 3 frame\(s\), 0 errors, 0 warning\(s\)$/m);
  });

  it("parses as bash", () => {
    expect(() => execFileSync("bash", ["-n", join(packageRoot, "assets", "autopilot", "run.sh")])).not.toThrow();
  });
});
