import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildSnapMeshScript } from "./surface-snap-mesh.js";

const engine = process.env.SUMMER_EDITOR_BIN;

it.skipIf(!engine)("seats visible mesh edges on the first crossed shelf", () => {
  const project = mkdtempSync(join(tmpdir(), "summer-crossing-edges-"));
  try {
    writeFileSync(join(project, "project.godot"), 'config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    copyFileSync(fileURLToPath(new URL("../../../tests/godot/snap-crossing-edges.gd", import.meta.url)), join(project, "regression.gd"));
    writeFileSync(join(project, "snap.gd"), buildSnapMeshScript({ subject: "Plank", direction: [0, -1, 0], gap: 0.15, max_distance: 20, native_support: "Shelf" }));
    const run = spawnSync(engine!, ["--headless", "--summer-no-api", "--audio-driver", "Dummy", "--path", project, "--script", "res://regression.gd"], { encoding: "utf8", timeout: 30_000 });
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stderr).not.toMatch(/(?:SCRIPT )?ERROR:/);
    const { rows, slopes, parents } = JSON.parse(readFileSync(join(project, "result.json"), "utf8")) as {
      rows: { support: string; contact: string; normal: number[]; mesh_height: number; verified_gap: number }[];
      parents: { actual_gap?: number; failure?: string }[];
      slopes: { support: string; mesh_gap: number; verified_gap: number }[];
    };
    expect(rows.map(row => row.support)).toEqual(["Shelf", "Shelf", "Shelf", "Floor", "Floor"]);
    expect(rows.slice(0, 2).map(row => row.contact)).toEqual(["crossing_edges", "crossing_edges"]);
    rows.slice(0, 2).forEach(row => expect(row.normal[1]).toBeCloseTo(1, 6));
    rows.forEach((row, i) => {
      expect(row.mesh_height).toBeCloseTo(i < 3 ? 3.15 : 0.15, 4);
      expect(row.verified_gap).toBeCloseTo(0.15, 4);
    });
    expect(parents).toHaveLength(4);
    parents.slice(0, 3).forEach(row => expect(row.actual_gap).toBeCloseTo(0.15, 4));
    expect(parents[3]).toEqual({ failure: "translation_not_representable" });
    for (const slope of slopes) {
      expect(slope.support).toBe("Shelf");
      expect(slope.mesh_gap).toBeCloseTo(0.15, 3);
      expect(slope.verified_gap).toBeCloseTo(0.15, 3);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
