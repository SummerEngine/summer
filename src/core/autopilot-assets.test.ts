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

  checkCanonical(
    `keeps probe_base.gd byte-identical to the engine's canonical copy${
      canonicalFound ? "" : ` (SKIPPED: no engine checkout at ${canonical}; set SUMMER_ENGINE_REPO)`
    }`,
    () => {
      expect(readFileSync(vendored, "utf-8")).toBe(readFileSync(canonical, "utf-8"));
    }
  );
});
