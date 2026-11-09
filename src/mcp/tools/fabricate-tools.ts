import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withEngine, missingEngineOpResult, withOldEngineHint } from "./with-engine.js";
import {
  FABRICATE_FALLBACK,
  buildFabricateMeshOp,
  fabricateArgsSchema,
} from "../../core/capabilities/fabricate-mesh.js";

export function registerFabricateTools(server: McpServer): void {
  server.tool(
    "summer_fabricate_3d",
    `Fabricate a 3D mesh asset by running a Blender Python (bpy) script in the USER'S OWN installed Blender — headless, supervised by the engine — then import the exported .glb into the project and optionally instantiate it into the open scene. Blender is a dependency the user installs; Summer never bundles, downloads, or brands it.

WHEN — the three asset classes neither generation nor the free library serve well:
- modular kits with exact dimensions and snapping (walls, pipes, fences, rails: array + boolean + bevel, one shared material) — generation cannot hold size and style across 30 pieces;
- VFX meshes (shatter pieces, curve sweeps, trails, LOD chains) — one-liners in bpy, absent in the engine;
- post-processing a generated model (decimate -> UV unwrap -> bake) before it goes into the scene.
WHEN NOT: a generic prop (barrel, crate, chair) -> summer_search_assets / summer_import_asset first, then summer_generate_3d; a character or any organic shape -> summer_generate_3d (scripted organic modelling is the documented failure mode); a blockout or placeholder -> summer_run_script primitives/CSG, instant and in-scene. Route with the asset-strategy skill; the fabricating-assets skill carries the bpy rules, recipes and the fix for each failure_reason.

SCRIPT CONTRACT: 'source' is plain bpy that must CREATE mesh objects and leave them linked in the scene — do NOT export and do NOT quit. The engine's bootstrap exports for you: modifiers applied, Geometry Nodes realized, +Y-up conversion, materials as Principled BSDF only, a procedural Base Color baked to a 2K texture; procedural Metallic/Roughness/Normal/Emission are NOT baked (see 'warnings'). Hidden or render-disabled objects are helpers (boolean cutters, guides), not exported, listed in 'skipped'. Model in metres. MESH/CURVE/SURFACE/META/FONT export as meshes, EMPTY/ARMATURE keep hierarchy, cameras and lights are dropped. Name your objects — they become node names.

REQUIRES BLENDER 4.2 LTS or newer. Resolution: 'blender_path' -> SUMMER_BLENDER_BIN in the editor's environment -> Editor Settings filesystem/import/blender/blender_path -> PATH, well-known install dirs, ~/.summer/tools/blender-*. Not found -> failure_reason blender_not_found with the exact fix and every path checked; relay it to the user as a one-line decision; never guess a path or install anything for them.

ONE fabrication runs at a time per editor (failure_reason busy: wait for the result, never fire two in parallel). There is no viewport feedback while the script runs, so keep scripts deterministic (fixed seeds) and verify afterwards.

Returns blender_version, blender_path, out_path, objects[{name, type, vertices, faces, triangles, materials, modifiers}], object_count, dimensions{x,y,z} (+Y up, source scale), warnings, baked, skipped, output, errors, exit_code, duration_ms, checkpoint; with import_to_scene also imported_node_path / scale_applied / instance_dimensions; no_rewind_point:true when no checkpoint exists. failure_reason: blender_not_found | blender_launch_failed | script_error (traceback_tail + script_line; fix the bpy for the reported blender_version) | timeout (raise max_seconds or split the job) | export_empty (check hide/render flags and collection links) | export_failed | export_missing | import_failed / instantiate_failed (the .glb IS at out_path: summer_instantiate_scene it yourself; importer message in summer_get_console) | busy | cancelled.

THE LOOP: summer_world_snapshot BEFORE (keep snapshot_id) -> summer_fabricate_3d with import_to_scene (+ target_size for real-world scale) -> read dimensions/warnings/skipped -> summer_snapshot_diff + summer_screenshot -> iterate. Never claim a visual result without the screenshot. An engine build without FabricateMesh returns a structured engine_lacks_op failure (nothing is sent): use summer_generate_3d / summer_search_assets, or update Summer Engine.`,
    fabricateArgsSchema.shape,
    async (args) =>
      withEngine(async (client) => {
        const missing = missingEngineOpResult(client, "FabricateMesh", FABRICATE_FALLBACK);
        if (missing) return missing;
        const { op, timeoutMs } = buildFabricateMeshOp(args);
        const result = await client.executeIdentityBoundOps([op], undefined, timeoutMs);
        return withOldEngineHint(result, "FabricateMesh", FABRICATE_FALLBACK);
      })
  );
}
