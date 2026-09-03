/**
 * Mesh-fabrication op builder (tool/fabricate-3d -> engine op FabricateMesh).
 * Shared by the MCP tool (summer_fabricate_3d) and the CLI dispatcher
 * (`summer tool fabricate-3d`) so both faces validate the same arguments, send
 * the same op with the same clamps, and wait the same client poll budget.
 *
 * What the op does on the engine side (fabricate_ops.cpp, wave K): run one
 * agent-authored bpy script in a supervised headless child of the USER'S OWN
 * Blender install, validate the .glb the child exported, move it under res://,
 * wait for the editor import to settle, and optionally instantiate it into the
 * edited scene. This package never spawns Blender, never imports bpy, and
 * never downloads or bundles Blender — it only sends the op. "Blender" appears
 * in user-facing text only as the name of the dependency.
 *
 * Server-side clamps mirrored here: 15..600 s, default 120 — the budget covers
 * Blender boot + the script + procedural-colour bakes + export, so the floor is
 * the same as RunEditorScript's child-editor floor.
 */

import { z } from "zod";
import { ToolInputError } from "../tool-errors.js";

export const FABRICATE_MIN_SECONDS = 15;
export const FABRICATE_MAX_SECONDS = 600;
export const FABRICATE_DEFAULT_SECONDS = 120;

/** Client poll headroom beyond the engine's own budget: the res:// move, the
 *  import settle-wait and InstantiateScene all run AFTER the child exits. */
export const FABRICATE_CLIENT_HEADROOM_MS = 60_000;

/** Where the engine writes the .glb when out_path is omitted. */
export const FABRICATE_DEFAULT_OUT_DIR = "res://assets/fabricated/";

/** What the tool tells the model to do when the engine lacks FabricateMesh. */
export const FABRICATE_FALLBACK =
  "generate the asset with summer_generate_3d, import one from the free library with summer_search_assets / summer_import_asset, use summer_import_hdri for environment lighting, or build blockout geometry in-scene with summer_add_node / summer_set_prop or a summer_run_editor_script";

const VECTOR3_VARIANT_RE =
  /^Vector3\(\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*,\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*,\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*\)$/;

/**
 * Mirror of the engine's out_path pre-validation (fabricate_ops.cpp
 * _resolve_out_path) so a bad destination is refused on this side with the
 * same words, and nothing is sent. Returns null when the path is acceptable.
 */
export function fabricateOutPathProblem(rawPath: string): string | null {
  const path = rawPath.trim().replace(/\\/g, "/");
  if (!path.startsWith("res://")) return `out_path must start with res:// (got '${path}').`;
  if (!/\.glb$/i.test(path)) {
    return "out_path must end in .glb; the fabricator exports binary glTF which the engine imports as a scene.";
  }
  const parts = path.slice("res://".length).split("/").filter((part) => part.length > 0);
  if (parts.length < 1) return "out_path must name a file under res://.";
  for (const part of parts) {
    if (part === "..") return "out_path may not contain '..'.";
    if (part.startsWith(".")) {
      return `out_path may not point into a hidden directory or file (the editor never imports those): ${path}`;
    }
  }
  return null;
}

/**
 * The one input contract for summer_fabricate_3d, shared by the MCP tool
 * (pass `.shape` to server.tool) and the CLI dispatcher (`summer tool
 * fabricate-3d`) so both faces reject the same inputs with the same message.
 */
export const fabricateArgsSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      "Blender Python (bpy) code that CREATES mesh objects and leaves them linked in the scene. Do not export — the engine exports the .glb for you. Pre-bound names: bpy, bmesh, mathutils, math, Vector, Matrix, Euler."
    ),
  name: z
    .string()
    .min(1)
    .describe(
      "Asset name — used for the default out_path (res://assets/fabricated/<name>.glb) and for the instantiated node. Sanitized by the engine to [A-Za-z0-9_-]."
    ),
  out_path: z
    .string()
    .superRefine((value, ctx) => {
      const problem = fabricateOutPathProblem(value);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    })
    .optional()
    .describe(
      "Destination res:// path ending in .glb (default res://assets/fabricated/<name>.glb). An existing file is overwritten; '..' and hidden directories are refused."
    ),
  target_size: z
    .number()
    .positive()
    .optional()
    .describe(
      "Largest world-AABB dimension in units after instantiation — uniform scale, same rule as summer_instantiate_scene target_size (chair 1.0, car 4.5). Only used together with import_to_scene."
    ),
  import_to_scene: z
    .object({
      parent: z
        .string()
        .describe("Parent node path in the CURRENTLY OPEN scene, e.g. '/' (scene root) or './World'."),
      position: z
        .string()
        .regex(VECTOR3_VARIANT_RE, "position must be a 'Vector3(x, y, z)' variant string")
        .optional()
        .describe("Optional local position as the engine variant string 'Vector3(x, y, z)'."),
    })
    .optional()
    .describe(
      "Instantiate the imported .glb into the currently open scene after import (one undo action). Omit to only write and import the file."
    ),
  max_seconds: z
    .number()
    .optional()
    .describe(
      "Child budget in seconds (default 120, clamped 15-600): Blender boot + script + procedural-colour bakes + export. Raise it for heavy booleans or bakes; the client waits max_seconds + 60 s."
    ),
  checkpoint: z
    .boolean()
    .optional()
    .describe(
      "Take a SummerGit checkpoint before the child runs (default false). The result confesses (no_rewind_point) when none could be taken."
    ),
  blender_path: z
    .string()
    .optional()
    .describe(
      "Explicit Blender executable. Pass only when the user named one; otherwise the engine resolves SUMMER_BLENDER_BIN, the editor setting filesystem/import/blender/blender_path, then PATH and well-known install locations."
    ),
});

export interface FabricateImportToScene {
  parent: string;
  position?: string;
}

export interface FabricateMeshArgs {
  source: string;
  name: string;
  out_path?: string;
  target_size?: number;
  import_to_scene?: FabricateImportToScene;
  max_seconds?: number;
  checkpoint?: boolean;
  blender_path?: string;
}

export interface BuiltFabricateOp {
  op: Record<string, unknown>;
  /** Client poll budget — MUST outlive the engine's own max_seconds plus the
   *  main-thread finalizer (move, import settle, instantiate), or a long but
   *  successful fabrication is reported as timed_out client-side. */
  timeoutMs: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Build the single FabricateMesh op (+ client budget) from validated args.
 * Re-checks the pre-apply invariants so a caller that bypasses the zod schema
 * still cannot send a bad destination or an unusable script: every throw here
 * is a ToolInputError, classified as "nothing was sent" by both faces.
 */
export function buildFabricateMeshOp(args: FabricateMeshArgs): BuiltFabricateOp {
  if (typeof args.source !== "string" || args.source.trim().length === 0) {
    throw new ToolInputError(
      "source is required: bpy code that creates mesh objects and leaves them linked in the scene (the engine exports them)."
    );
  }
  if (typeof args.name !== "string" || args.name.trim().length === 0) {
    throw new ToolInputError("name is required: it names the .glb (res://assets/fabricated/<name>.glb) and the instantiated node.");
  }

  const budgetSeconds = clamp(
    typeof args.max_seconds === "number" && Number.isFinite(args.max_seconds)
      ? args.max_seconds
      : FABRICATE_DEFAULT_SECONDS,
    FABRICATE_MIN_SECONDS,
    FABRICATE_MAX_SECONDS
  );

  const op: Record<string, unknown> = {
    op: "FabricateMesh",
    script_source: args.source,
    name: args.name.trim(),
    max_seconds: budgetSeconds,
  };

  if (typeof args.out_path === "string" && args.out_path.trim().length > 0) {
    const problem = fabricateOutPathProblem(args.out_path);
    if (problem) throw new ToolInputError(problem);
    op.out_path = args.out_path.trim().replace(/\\/g, "/");
  }

  if (args.target_size !== undefined) {
    if (typeof args.target_size !== "number" || !Number.isFinite(args.target_size) || args.target_size <= 0) {
      throw new ToolInputError("target_size must be a positive number (largest AABB dimension after instantiation).");
    }
    op.target_size = args.target_size;
  }

  if (args.import_to_scene !== undefined) {
    const spec = args.import_to_scene;
    const parent = typeof spec.parent === "string" && spec.parent.trim().length > 0 ? spec.parent.trim() : "/";
    const importSpec: Record<string, unknown> = { parent };
    if (spec.position !== undefined) {
      if (typeof spec.position !== "string" || !VECTOR3_VARIANT_RE.test(spec.position.trim())) {
        throw new ToolInputError(
          `import_to_scene.position must be a 'Vector3(x, y, z)' variant string (got ${JSON.stringify(spec.position)}).`
        );
      }
      importSpec.position = spec.position.trim();
    }
    op.import_to_scene = importSpec;
  }

  if (args.checkpoint !== undefined) op.checkpoint = args.checkpoint;
  if (typeof args.blender_path === "string" && args.blender_path.trim().length > 0) {
    op.blender_path = args.blender_path.trim();
  }

  return { op, timeoutMs: budgetSeconds * 1000 + FABRICATE_CLIENT_HEADROOM_MS };
}
