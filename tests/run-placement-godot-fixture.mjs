// Run from a built toolkit checkout with a path to the local Summer editor and a fixture .gd file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPlacementScript } from "../dist/core/capabilities/placement-script.js";

const [, , executable, fixture] = process.argv;
assert(executable && fixture, "Usage: node tests/run-placement-godot-fixture.mjs <editor> <fixture.gd>");
const directory = mkdtempSync(join(tmpdir(), "summer-placement-fixture-"));
try {
  const home = join(directory, "home");
  mkdirSync(home);
  writeFileSync(join(directory, "project.godot"), "config_version=5\n");
  writeFileSync(join(directory, "probe.gd"), buildPlacementScript({}));
  copyFileSync(fixture, join(directory, "test.gd"));
  const stdout = execFileSync(resolve(executable), [
    "--headless", "--path", directory, "--summer-no-api", "--summer-no-publish", "--audio-driver", "Dummy", "--script", "res://test.gd",
  ], { cwd: directory, env: { HOME: home, PATH: process.env.PATH, SUMMER_NO_TELEMETRY: "1" }, timeout: 30_000, encoding: "utf8" });
  assert(stdout.includes("PLACEMENT_FIXTURE_OK"), stdout);
  console.log("PASS", fixture);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
