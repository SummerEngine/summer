import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const editor = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(editor)).each(["Jolt Physics", "GodotPhysics3D"])("matches painted cylinders to physics on %s", (backend) => {
  const project = mkdtempSync(join(tmpdir(), "painted-cylinder-collision-"));
  try {
    copyFileSync(new URL("../../library/skills/painted-25d-world/_building-blocks/blockout_builder.gd", import.meta.url), join(project, "builder.gd"));
    copyFileSync(new URL("../../tests/godot/painted-blockout-cylinders.gd", import.meta.url), join(project, "test.gd"));
    writeFileSync(join(project, "project.godot"), `config_version=5\n[physics]\n3d/physics_engine="${backend}"\n`);
    const cases = [
      { name: "Cone", r_bot: 1, r_top: 0, scale: [1, 1, 1] },
      { name: "InvertedFrustum", r_bot: 0.2, r_top: 1, scale: [1, 1, 1] },
      { name: "Level", r_bot: 0.8, r_top: 0.8, scale: [1.5, 0.7, 1.5] },
      { name: "Ellipse", r_bot: 0.8, r_top: 0.8, scale: [1.6, 0.7, 0.5] },
    ];
    const objects = cases.flatMap((cylinder, index) => [true, false].map((solid) => ({
      ...cylinder, kind: "cyl", name: cylinder.name + (solid ? "Solid" : "Decor"), color: "bark",
      solid, pos: [index * 10, 0, solid ? 10 : 0], height: 2,
    })));
    writeFileSync(join(project, "objects.json"), JSON.stringify({ objects }));
    execFileSync(editor!, ["--headless", "--path", project, "--audio-driver", "Dummy", "--summer-no-api", "--summer-no-publish", "--script", "res://test.gd"], {
      env: { ...process.env, HOME: project, SUMMER_NO_TELEMETRY: "1" }, timeout: 15_000,
    });
    const samples: { name: string; solid: boolean; expected: number; visual: number; collision: number | null }[] =
      JSON.parse(readFileSync(join(project, "results.json"), "utf8"));
    expect(samples).toHaveLength(objects.length * 4);
    for (const sample of samples) {
      expect(sample.visual, sample.name).toBeCloseTo(sample.expected, 3);
      if (sample.solid) expect(sample.collision, sample.name).toBeCloseTo(sample.visual, 3);
      else expect(sample.collision, sample.name).toBeNull();
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
