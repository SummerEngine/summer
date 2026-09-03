import { describe, expect, it } from "vitest";
import { ToolInputError } from "../tool-errors.js";
import {
  FABRICATE_CLIENT_HEADROOM_MS,
  FABRICATE_DEFAULT_SECONDS,
  FABRICATE_FALLBACK,
  FABRICATE_MAX_SECONDS,
  FABRICATE_MIN_SECONDS,
  buildFabricateMeshOp,
  fabricateArgsSchema,
  fabricateOutPathProblem,
} from "./fabricate-mesh.js";

const SCRIPT = "import bpy\nbpy.ops.mesh.primitive_cube_add(size=1)\n";

describe("buildFabricateMeshOp", () => {
  it("sends exactly the op contract with the default budget and no optional keys", () => {
    const { op, timeoutMs } = buildFabricateMeshOp({ source: SCRIPT, name: "crate" });
    expect(op).toEqual({
      op: "FabricateMesh",
      script_source: SCRIPT,
      name: "crate",
      max_seconds: FABRICATE_DEFAULT_SECONDS,
    });
    // out_path is left to the engine (res://assets/fabricated/<name>.glb) —
    // the default lives in ONE place, the engine, so the two never disagree.
    expect(op).not.toHaveProperty("out_path");
    expect(op).not.toHaveProperty("checkpoint");
    expect(op).not.toHaveProperty("import_to_scene");
    expect(timeoutMs).toBe(FABRICATE_DEFAULT_SECONDS * 1000 + FABRICATE_CLIENT_HEADROOM_MS);
  });

  it("clamps max_seconds to the engine's 15..600 window and budgets the client 60 s beyond it", () => {
    expect(buildFabricateMeshOp({ source: SCRIPT, name: "a", max_seconds: 1 }).op.max_seconds).toBe(
      FABRICATE_MIN_SECONDS
    );
    const long = buildFabricateMeshOp({ source: SCRIPT, name: "a", max_seconds: 9_999 });
    expect(long.op.max_seconds).toBe(FABRICATE_MAX_SECONDS);
    expect(long.timeoutMs).toBe(FABRICATE_MAX_SECONDS * 1000 + 60_000);
    expect(buildFabricateMeshOp({ source: SCRIPT, name: "a", max_seconds: 44.6 }).op.max_seconds).toBe(45);
    expect(buildFabricateMeshOp({ source: SCRIPT, name: "a", max_seconds: Number.NaN }).op.max_seconds).toBe(
      FABRICATE_DEFAULT_SECONDS
    );
  });

  it("passes every optional field through in the engine's shape", () => {
    const { op } = buildFabricateMeshOp({
      source: SCRIPT,
      name: " wall_2m ",
      out_path: "res://assets/kit/wall_2m.glb",
      target_size: 2,
      import_to_scene: { parent: "./Kit", position: "Vector3(0, 0, -4)" },
      max_seconds: 300,
      checkpoint: true,
      blender_path: "/opt/blender/blender",
    });
    expect(op).toEqual({
      op: "FabricateMesh",
      script_source: SCRIPT,
      name: "wall_2m",
      out_path: "res://assets/kit/wall_2m.glb",
      target_size: 2,
      import_to_scene: { parent: "./Kit", position: "Vector3(0, 0, -4)" },
      max_seconds: 300,
      checkpoint: true,
      blender_path: "/opt/blender/blender",
    });
  });

  it("defaults an empty import_to_scene parent to the scene root", () => {
    const { op } = buildFabricateMeshOp({ source: SCRIPT, name: "a", import_to_scene: { parent: "  " } });
    expect(op.import_to_scene).toEqual({ parent: "/" });
  });

  it("refuses an unusable script, name, destination, size or position BEFORE anything is sent", () => {
    expect(() => buildFabricateMeshOp({ source: "   ", name: "a" })).toThrow(ToolInputError);
    expect(() => buildFabricateMeshOp({ source: SCRIPT, name: "" })).toThrow(ToolInputError);
    expect(() => buildFabricateMeshOp({ source: SCRIPT, name: "a", out_path: "user://x.glb" })).toThrow(
      /must start with res:\/\//
    );
    expect(() => buildFabricateMeshOp({ source: SCRIPT, name: "a", out_path: "res://x.gltf" })).toThrow(
      /must end in \.glb/
    );
    expect(() => buildFabricateMeshOp({ source: SCRIPT, name: "a", out_path: "res://../x.glb" })).toThrow(
      /may not contain '\.\.'/
    );
    expect(() => buildFabricateMeshOp({ source: SCRIPT, name: "a", out_path: "res://.godot/x.glb" })).toThrow(
      /hidden directory/
    );
    expect(() => buildFabricateMeshOp({ source: SCRIPT, name: "a", target_size: 0 })).toThrow(/target_size/);
    expect(() =>
      buildFabricateMeshOp({ source: SCRIPT, name: "a", import_to_scene: { parent: "/", position: "0,0,0" } })
    ).toThrow(/Vector3\(x, y, z\)/);
  });

  it("names every fallback tool an engine without the op should route to", () => {
    for (const tool of ["summer_generate_3d", "summer_search_assets", "summer_import_hdri", "summer_run_editor_script"]) {
      expect(FABRICATE_FALLBACK).toContain(tool);
    }
  });
});

describe("fabricateOutPathProblem", () => {
  it("accepts a plain res:// .glb path (case-insensitive extension, backslashes normalized)", () => {
    expect(fabricateOutPathProblem("res://assets/fabricated/crate.glb")).toBeNull();
    expect(fabricateOutPathProblem("res://Crate.GLB")).toBeNull();
    expect(fabricateOutPathProblem("res://assets\\kit\\wall.glb")).toBeNull();
  });

  it("rejects the same shapes the engine's _resolve_out_path rejects", () => {
    expect(fabricateOutPathProblem("res://")).toMatch(/must end in \.glb/);
    expect(fabricateOutPathProblem("res://.glb")).toMatch(/hidden/);
    expect(fabricateOutPathProblem("res://a/.hidden/b.glb")).toMatch(/hidden/);
    expect(fabricateOutPathProblem("/abs/path.glb")).toMatch(/res:\/\//);
  });
});

describe("fabricateArgsSchema (the shared zod contract)", () => {
  it("rejects on both faces what the builder rejects, with the same message", () => {
    const bad = fabricateArgsSchema.safeParse({ source: SCRIPT, name: "a", out_path: "res://../x.glb" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]!.message).toMatch(/may not contain '\.\.'/);

    const badPos = fabricateArgsSchema.safeParse({
      source: SCRIPT,
      name: "a",
      import_to_scene: { parent: "/", position: "(1, 2, 3)" },
    });
    expect(badPos.success).toBe(false);

    const missingParent = fabricateArgsSchema.safeParse({ source: SCRIPT, name: "a", import_to_scene: {} });
    expect(missingParent.success).toBe(false);
  });

  it("accepts the full contract", () => {
    const ok = fabricateArgsSchema.safeParse({
      source: SCRIPT,
      name: "pipe",
      out_path: "res://assets/kit/pipe.glb",
      target_size: 1.5,
      import_to_scene: { parent: "/", position: "Vector3(1.5, -2, 3e1)" },
      max_seconds: 200,
      checkpoint: false,
      blender_path: "/Applications/Blender.app/Contents/MacOS/Blender",
    });
    expect(ok.success).toBe(true);
  });
});
