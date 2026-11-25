import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildPlacementScript } from "./placement-script.js";

const binary = process.env.SUMMER_BIN;
const directory = new URL("../../../tests/godot/", import.meta.url);
const portFixtures = readdirSync(directory).filter((name) => name.startsWith("port-loop-") && name.endsWith(".gd")).sort();

it.skipIf(!binary).each([...portFixtures, "inspect-gridmap-cells.gd", "placement-gridmap-readouts.gd", "placement-csg-bounds.gd", "placement-shadow-only.gd"])("matches native Godot in %s", (fixture) => {
  const project = mkdtempSync(join(tmpdir(), "summer-placement-"));
  try {
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    writeFileSync(join(project, "probe.gd"), buildPlacementScript({}));
    copyFileSync(new URL(fixture, directory), join(project, "case.gd"));
    const output = execFileSync(binary!, [
      "--headless", "--path", project, "--summer-no-api", "--summer-no-publish", "--audio-driver", "Dummy", "--script", "res://case.gd",
    ], { cwd: project, env: { HOME: project, PATH: process.env.PATH, SUMMER_NO_TELEMETRY: "1" }, timeout: 30000, encoding: "utf8" });
    expect(output).toContain("PLACEMENT_FIXTURE_OK");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 35000);
