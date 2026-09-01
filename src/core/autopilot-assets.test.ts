import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
const canonical = resolve(packageRoot, "..", "..", "modules", "1summer_engine", "verify", "summer_probe_base.gd");

describe("autopilot scaffold", () => {
  it("ships every file the scaffold needs", () => {
    for (const name of ["autopilot.gd", "probe_base.gd", "run.sh", "README.md"]) {
      expect(existsSync(join(packageRoot, "assets", "autopilot", name)), name).toBe(true);
    }
  });

  it("never tells the probe runner to use --headless (no renderer, no frames)", () => {
    const runner = readFileSync(join(packageRoot, "assets", "autopilot", "run.sh"), "utf-8");
    // Comments are allowed to mention the flag — that is where we explain why not
    // to use it. Only executable lines matter.
    const code = runner
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/--headless/);
    expect(code).toMatch(/--summer-verify/);
    // Agent-driven runs must not arm the crash handler: it popen()s atos from
    // inside a signal handler, turning a clean failure into a hang.
    expect(code).toMatch(/--disable-crash-handler/);
  });

  it("keeps probe_base.gd byte-identical to the engine's canonical copy", () => {
    // Only enforceable inside the engine monorepo; the published package has no
    // modules/ tree, so skip rather than fail there.
    if (!existsSync(canonical)) return;
    expect(readFileSync(vendored, "utf-8")).toBe(readFileSync(canonical, "utf-8"));
  });
});
