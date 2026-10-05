import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withEngine } from "./with-engine.js";
import {
  attachToSurface,
  attachToSurfaceArgsSchema,
  connectPorts,
  connectPortsArgsSchema,
  inspectAsset,
  inspectAssetArgsSchema,
  measure,
  measureArgsSchema,
  placeAdjacent,
  placeAdjacentArgsSchema,
  raycast,
  raycastArgsSchema,
  repeatAlong,
  repeatAlongArgsSchema,
  type PlacementClient,
  type PlacementResult,
} from "../../core/capabilities/placement.js";

/**
 * Kit-placement tools: measure an asset before instancing it, place pieces
 * relative to each other, mount them on surfaces, repeat them along a line,
 * join ports, and query the scene with arbitrary rays and per-axis measures.
 *
 * The implementations live in core/capabilities/placement.ts (shared with
 * `summer tool <slug>`). They use only existing engine ops: the placement
 * probe runs through RunSceneScript (read-only, undo "none", no checkpoint)
 * and mutations are SetProp / SnapToSurface / InstantiateScene with the usual
 * scene target, undo step and final SaveScene.
 *
 * Results are rendered here, not by withEngine's failure renderer: a placement
 * failure carries structured fields (failure_reason, what already applied,
 * the measured hit) that a plain error string would drop.
 */

const RESULT_LIMIT_BYTES = 5 * 1024;

type Content = { type: "text"; text: string };

export function renderPlacementResult(body: PlacementResult | Record<string, unknown>): { content: Content[]; isError?: true } {
  let text = JSON.stringify(body);
  if (Buffer.byteLength(text, "utf8") > RESULT_LIMIT_BYTES) {
    text = JSON.stringify({
      ok: false,
      tool: body.tool,
      failure_reason: "result_exceeded_byte_limit",
      error: "The placement result was larger than 5 KB and was not forwarded. Narrow the request (fewer nodes or copies).",
      ...(body.ok === true ? { mutationApplied: body.saved === true, retrySafe: false } : {}),
    });
    return { content: [{ type: "text", text }], isError: true };
  }
  return body.ok === true ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], isError: true };
}

/** withEngine wrapper that renders the placement result verbatim. */
export function runPlacement<T>(run: (client: PlacementClient, args: T) => Promise<PlacementResult>) {
  return async (args: T) =>
    withEngine(async (client) => ({ placementResult: await run(client, args) }), {
      onResult: (wrapped) => renderPlacementResult(wrapped.placementResult),
    });
}

export function registerPlacementTools(server: McpServer): void {
  server.tool(
    "summer_inspect_asset",
    `Measure a 3D asset file (.tscn/.scn/.glb/.gltf, or a Mesh resource) WITHOUT adding it to any scene: it is loaded and instanced off-scene in the editor, measured, and freed. Call it once per kit piece before placing it, instead of guessing size, origin or facing.

Returns (all in the asset root's own frame, the frame position/rotation apply in), the facing evidence first:
- summary {aabb, origin {fraction, label e.g. "x:center y:min z:min"}, plane_pairs, port_like_loops [loop ids], triangles, mesh_count, anchor_count, collision_count, warnings?}. plane_pairs: the 2 largest pairs of opposite planes (a pair under 1% of the largest one's area is left out), each {larger, opposite (null for a single sheet), separation}; every plane {axis (e.g. "+z", only when the normal is within about 1 degree of it), normal, offset, area, one_sided}. one_sided true = its material culls back faces, so the plane is invisible from behind its normal: a single sheet that is one_sided faces along its normal and its back is the opposite axis. An oblique normal (no axis) means a baked yaw or a 45-degree corner face. warnings says when the triangle budget cut the analysis and which maxTriangles covers the whole mesh
- aabb, origin, meshes [{path, tris, min, max}], triangles total
- planes: the 6 largest planar face groups {normal, offset, area, tris, cull_back, one_sided}; normals follow the triangle winding (outward faces). You decide the front; the tool does not label facing
- open_loops: open boundary loops {id, index, mesh, center, direction (outward), radius, vertices, max_dev} in a stable order: grouped by the piece axis the direction is nearest (+X, -X, +Y, -Y, +Z, -Z; ~X/~Y/~Z when undecided), the outermost along that axis first, then by centre; never by radius. id names the loop by that order: "+Y" is the outermost loop facing +Y, "+Y#2" the next. summer_connect_ports accepts the id (or the index); the same id names the same loop on the placed node in any pose. detail "summary" (default) lists only port-like loops (radius over 2 cm with a partner loop facing more than 60 degrees away: the ends of a pipe, duct or bend; or the one opening of an end piece, such as an outlet's socket, on its bounding-box face) and says how many it omitted; detail "full" lists every loop, including the outline of flat sheets
- anchors: Marker3D nodes {name, path, position, forward (-Z), up}
- collision: CollisionShape3D nodes {path, shape, size/radius/height/faces, center, min, max}
- analysis {triangles_analyzed, triangle_budget, truncated}; a "truncated" object when a list was cut to fit 5 KB

maxTriangles 100-300000 (default 60000). Evidence is mesh_triangles. Uses the existing RunSceneScript op (in the live editor, read-only); an engine without it answers engine_lacks_op.`,
    inspectAssetArgsSchema.shape,
    runPlacement(inspectAsset)
  );

  server.tool(
    "summer_place_adjacent",
    `Move one node so its bounds face sits against another node's bounds face along one axis: facade modules edge to edge, a storey stacked on the one below, a cornice on a wall. Optionally line up the other two axes (min, center or max), per axis.

Example: next module to the right, same base height, same front plane: {axis:"x", side:"max", gap:0, alignOtherAxes:{y:"min", z:"max"}}.

Bounds are the visible GeometryInstance3D AABBs (the definition summer_align_distribute_3d uses; evidence visual_aabb). space "local" uses the reference's own axes for rotated facades. When the subject is inside the reference, its geometry is left out of the reference's bounds. One SetProp on position, one undo step, then the scene is saved; a fresh read verifies the achieved gap and residuals (verify). Returns {moved_by, position, verify:{gap, residuals}}. The scene must be open in the editor (any tab).`,
    placeAdjacentArgsSchema.shape,
    runPlacement(placeAdjacent)
  );

  server.tool(
    "summer_attach_to_surface",
    `Mount a piece on a surface: turn it so its given LOCAL backAxis faces into the surface (opposite the hit normal) with its upAxis kept toward worldUp, then seat its measured back face (the extreme of its visible bounds along backAxis, not its origin) at standoff from the surface. Pipes, gutters, lamps, AC units, signs, fire escapes. Place the piece near its mount first (summer_instantiate_scene with position); this tool turns it and pushes it onto the surface.

Find the surface with surface (a node: the ray runs from the subject's origin to the nearest point of that node's bounds) or ray {origin, direction} (both: the ray, and hits on other nodes are skipped). The ray is physics first; if physics finds nothing it falls back to visual AABBs and says so (the normal is then an AABB face normal). Get backAxis from summer_inspect_asset (the piece's back plane normal), not from a guess.

placeAt "current" (default): the piece keeps its height and its place along the surface and only moves along the surface normal. placeAt "hit": it also slides so the centre of its back face lands on the ray hit point.

Steps (existing ops): a read-only probe (RunSceneScript) reads the piece's bounds in its own axes and casts the ray; one SetProp turns the piece and puts its back face 5 cm in front of the planned seat; SnapToSurface sweeps it along -normal (at most standoff + 0.3) and seats it at standoff (its own physics/visual_aabb evidence). Before saving, the seat is checked:
- with surface: the seat must be on that node (or inside it), else it is refused;
- with a ray only: a seat on another node is refused unless it lies on the hit plane (a coplanar neighbour module, warned);
- the piece must end within maxMove (default 2) of where it started; a longer planned move is refused before anything changes, and so is (with placeAt "current") a ray hit farther than maxMove along the surface from the piece (hit_far_from_piece: aim at the piece, or pass placeAt "hit").
A refused or failed seat puts the piece back where it started (restored: true), saves nothing, and names the cause: seated_on, the seat's failure_reason, blockers {overlapping, overlaps, first_contact} and a next_step.

Returns {seated_on, final_gap (collider gap from SnapToSurface), back_face_gap (visible back face to the hit plane), moved_by, surface_hit, orientation, back_face_offset, seat {evidence, supportPath, finalGap, gapErrorBound, initiallyOverlapping, ...}, saved, warnings}. A warning visible_back_X_into_surface means the piece's collider sits behind its visible back: add X to standoff.`,
    attachToSurfaceArgsSchema.shape,
    runPlacement(attachToSurface)
  );

  server.tool(
    "summer_repeat_along",
    `Instance copies of one scene along a straight line in one call: wall clamps every 0.45 m, braces every 0.8 m, fence posts, a row of window modules. Give start plus end (with spacing or count) or start plus direction (with count and spacing); positions are in the parent's local space. align (start|center|end) places the leftover length when spacing does not divide the line. Each copy is an InstantiateScene (the engine runs each alone), named <namePrefix>_<n>; the copies' transforms (position, rotationDegrees, scale) are then set in one request and the scene is saved once: N copies cost N + 2 engine requests. At most 64 copies per call.

Returns a compact receipt: {count, spacing, first, last, created [node paths], renamed, failures [{index, error}], saved}. Lists are cut to stay under 5 KB and the cut is declared.`,
    repeatAlongArgsSchema.shape,
    runPlacement(repeatAlong)
  );

  server.tool(
    "summer_connect_ports",
    `Move and turn one piece so its port meets another piece's port, facing it: pipe to pipe, duct to duct, gutter section to funnel or outlet. A port is an open-loop id from summer_inspect_asset on that node's scene ("+Y" = the outermost open loop facing +Y in the piece's own axes, "+Y#2" the next one facing +Y; resolved on the live node's meshes in its own frame, so the id is the same in every pose), a Marker3D (or any Node3D) name under the node whose -Z axis points out of the port, or an open-loop index in the same stable order.

The subject turns by the shortest rotation that makes its port direction opposite the target's, then by rollDegrees about the joined axis, then moves so the ports coincide (gap along the target port's direction). rollDegrees: axis = roll_axis in the receipt (the target port direction reversed, pointing into the target); right-hand rule, positive = counter-clockwise seen from inside the target looking back at the subject; zero = the shortest turn from the subject's CURRENT orientation, so the same value differs between start poses. Once the ports are joined, a second call turns by exactly rollDegrees (180 flips a bend's free end to the other side).

Tilt guard: a join that would tilt the subject's up axis (its local +Y) more than maxTiltDegrees (default 5) is refused before anything changes (failure_reason tilt_exceeds_limit, with tilt_degrees and ports_within_limit: the subject ports that would join within the limit, least tilt first). Turning about the up axis is never tilt. Pass allowTilt true for an intended tilt (a bend laid on its side).

One SetProp on transform, saved; a fresh read verifies {distance, angle_degrees, tilt_degrees}. Returns {subject_port {kind, id|name, index, position, direction, radius}, target_port, roll_axis, roll_degrees, rotated_degrees, tilt_degrees, max_tilt_degrees, moved_by, other_ports, verify, warnings}. other_ports: every other port of the subject (its other Marker3D anchors, or its other open loops for an open-loop port) with world position and outward direction AFTER the move, measured by the verify read: read where a bend's free end now points instead of measuring it. Open-loop ports are only as exact as the mesh: check direction_ambiguous warnings and a screenshot.`,
    connectPortsArgsSchema.shape,
    runPlacement(connectPorts)
  );

  server.tool(
    "summer_raycast",
    `Cast one ray from any point in an open scene, before anything is placed there: find the wall, floor or ceiling in front of a point and its normal. (summer_starcast casts from an existing node's bounds; this casts from an arbitrary origin.)

evidence auto (default): physics first (collider hit: exact point and normal); if physics hits nothing, the nearest visible-mesh AABB hit, declared with fallback:true and fallback_reason. Physics needs the scene to be the active editor tab (only that scene's bodies are in the editor's physics space); otherwise auto falls back to visual AABBs. When physics hits but a mesh-only object is nearer, nearer_visual_only names it.

Returns {hit, evidence, path, point, normal, distance, origin, direction, physics_available, warnings}. Read-only (RunSceneScript probe, undo "none"); never saves.`,
    raycastArgsSchema.shape,
    runPlacement(raycast)
  );

  server.tool(
    "summer_measure",
    `Measure placement between specific nodes from their visible-mesh bounds (evidence visual_aabb). Read-only, never saves. Complements summer_starcast (which reports clearance around ONE node in 26 directions).

mode pair (a, b): per axis {gap (> 0 clearance, < 0 overlap depth), relation gap|touching|overlap, a/b intervals, delta_min/max/center (b minus a)} and boxes_overlap. Catches facade gaps and modules that overlap.
mode plane (nodes, face): whether that face of every node lies on one plane: {coplanar, plane (median), spread, nodes [{path, face, deviation, off_plane: proud|recessed}]}. Catches modules standing proud of a facade line. face '+z' = the face pointing along +z.

space "local" measures along the axes of a (pair) or nodes[0] (plane), for rotated facades. tolerance (default 5 mm) decides touching / coplanar.`,
    measureArgsSchema.shape,
    runPlacement(measure)
  );
}
