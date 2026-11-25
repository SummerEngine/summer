// On demand: node tests/painted-blockout-spheres.godot-test.mjs /path/to/Summer
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = process.argv[2];
assert(executable, "Pass the path to the Godot or Summer editor.");
const directory = mkdtempSync(join(tmpdir(), "painted-blockout-spheres-"));
try {
  const home = join(directory, "home");
  mkdirSync(home);
  copyFileSync(new URL("../library/skills/painted-25d-world/_building-blocks/blockout_builder.gd", import.meta.url), join(directory, "builder.gd"));
  copyFileSync(new URL("./godot/painted-blockout-spheres.gd", import.meta.url), join(directory, "test.gd"));

  const spheres = [
    { name: "round", scale: [1.5, 1.5, 1.5] },
    { name: "squash", sy: 0.25 },
    { name: "ellipsoid", sy: 0.25, scale: [2, 1.5, 0.5] },
    { name: "flat", sy: 0 },
  ];
  const objects = spheres.flatMap((sphere, index) => [false, true].map((solid) => ({
    ...sphere, name: sphere.name + (solid ? "Solid" : "Decor"), kind: "sphere", color: "bush",
    radius: 1, pos: [10 * index, 0, solid ? 10 : 0], solid,
  })));
  writeFileSync(join(directory, "blockout.json"), JSON.stringify({ objects }));
  for (const backend of ["Jolt Physics", "GodotPhysics3D"]) {
    writeFileSync(join(directory, "project.godot"), `config_version=5\n[physics]\n3d/physics_engine="${backend}"\n`);
    execFileSync(resolve(executable), ["--headless", "--path", directory, "--audio-driver", "Dummy", "--script", "res://test.gd"], {
      env: { PATH: process.env.PATH, HOME: home, SUMMER_NO_TELEMETRY: "1" }, timeout: 30000,
    });
    const rows = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    for (const sphere of spheres) {
      const solid = rows[sphere.name + "Solid"];
      const decor = rows[sphere.name + "Decor"];
      const scale = sphere.scale ?? [1, 1, 1];
      const expected = [scale[0], scale[1] * (sphere.sy ?? 1), scale[2]];
      for (let axis = 0; axis < 3; axis++) {
        assert(Math.abs(solid.extents[axis] - decor.extents[axis]) < 0.00001, sphere.name);
        assert(Math.abs(solid.extents[axis] - expected[axis]) < 0.005, sphere.name);
        if (sphere.name === "flat") assert.equal(solid.rays[axis], null);
        else assert(solid.rays[axis] !== null && Math.abs(solid.rays[axis] - expected[axis]) < 0.025, sphere.name);
        assert.equal(decor.rays[axis], null);
      }
      assert.equal(solid.shape, sphere.name === "round" ? "SphereShape3D" : sphere.name === "flat" ? null : "ConvexPolygonShape3D");
    }
    console.log(`PASS painted blockout spheres on ${backend}`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
