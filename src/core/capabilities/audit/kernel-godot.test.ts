import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AUDIT_KERNEL_PATH } from "./audit.js";

const engine = process.env.SUMMER_EDITOR_BIN;
if (!engine) console.warn("SKIP: audit kernel physics regression needs SUMMER_EDITOR_BIN (a local Summer Engine binary).");

it.skipIf(!engine)("measures scaled long props from real geometry and physics, like equivalent baked meshes", () => {
  const project = mkdtempSync(join(tmpdir(), "summer-audit-scale-"));
  try {
    writeFileSync(join(project, "project.godot"), 'config_version=5\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
    copyFileSync(AUDIT_KERNEL_PATH, join(project, "scene_audit.gd"));
    copyFileSync(fileURLToPath(new URL("../../../../tests/godot/wall-audit-scale.gd", import.meta.url)), join(project, "regression.gd"));
    const child = spawnSync(engine!, ["--headless", "--summer-no-api", "--audio-driver", "Dummy", "--path", project, "--script", "res://regression.gd"], { encoding: "utf8", timeout: 10_000 });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(child.stderr).not.toMatch(/(?:SCRIPT )?ERROR:/);
    const cases = JSON.parse(readFileSync(join(project, "result.json"), "utf8")) as Array<{ case: string; rows: unknown[][]; native_size: number[]; native_clearance: number }>;
    expect(cases).toHaveLength(10);
    for (const c of cases) {
      expect(c.rows, c.case).toHaveLength(1);
      const row = c.rows[0]!;
      const [x, z] = c.native_size as [number, number];
      expect(row[2], c.case).toBeCloseTo(Math.max(x, z), 3);
      expect(row[3], c.case).toBeCloseTo(Math.min(x, z), 3);
      expect(row[1], c.case).toEqual(x >= z ? [1, 0, 0] : [0, 0, 1]);
      expect((row[4] as unknown[])[0], c.case).toBeCloseTo(c.native_clearance, 3);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
