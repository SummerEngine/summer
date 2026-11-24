import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { basisDeterminant, localPositionAfterWorldDelta, xformFromArray, type Vec3 } from "./placement-math.js";
import { readSceneNodeTransform } from "./scene-space.js";

const binary = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(binary))("both native transform encodings give Godot's parent-local position under a mirrored or sheared rig", async () => {
  const project = mkdtempSync(join(tmpdir(), "parent-local-translation-"));
  try {
    const scene = fileURLToPath(new URL("../../../tests/godot/parent-local-translation.gd", import.meta.url));
    copyFileSync(scene, join(project, "check.gd"));
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
    execFileSync(binary!, ["--headless", "--path", project, "--audio-driver", "Dummy", "--script", "res://check.gd"], {
      env: { ...process.env, HOME: project, SUMMER_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" }, timeout: 15_000,
    });
    const rows = JSON.parse(readFileSync(join(project, "expected.json"), "utf8")) as Array<{
      literal: string; wire: number[]; original: Vec3; delta: Vec3; expected: Vec3; det: number;
    }>;
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      // The placement probe sends basis columns. RunSceneScript serializes the native parent as a row-major literal.
      const placement = xformFromArray(row.wire);
      const result = { ok: true, origin: [0, 0, 0], position: row.original, transform: row.literal, parent_transform: row.literal };
      const snap = await readSceneNodeTransform({ executeOps: async () => ({ ok: true, results: [{ op: "RunSceneScript", ok: true, result }] }) }, "Child");
      if ("error" in snap) throw new Error(snap.error);
      for (const basis of [placement.basis, snap.parentBasis]) {
        expect(basisDeterminant(basis)).toBeCloseTo(row.det, 4);
        const local = localPositionAfterWorldDelta(row.original, basis, row.delta);
        local.forEach((v, i) => expect(v).toBeCloseTo(row.expected[i]!, 4));
      }
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
