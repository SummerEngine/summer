/**
 * inspect-node — ONE implementation of `summer_inspect_node` for both faces
 * (src/mcp/tools/scene-tools.ts and tool-dispatch.ts).
 *
 * The engine's state:inspector returns every editor-visible property of a
 * node (StateProvider::inspector_state) — about 5 KB to read one transform.
 * `fields` keeps only the named properties (globs allowed) and adds a few
 * derived fields the inspector cannot give:
 *   transform        local position / rotation_degrees / scale (+ Transform3D
 *                    literal for 3D nodes);
 *   global_transform world origin/basis composed down the ancestor chain from
 *                    the world snapshot's local pos/rot_deg/scale;
 *   scene_file_path  the res:// scene the node instances (world snapshot);
 *   aabb             the node's world AABB (world snapshot);
 *   warnings         the node's configuration warnings.
 * The world snapshot is read only when one of its fields is asked for.
 */
import { z } from "zod";
import { missingEngineOpResult, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { annotateVariantTypes } from "./variant-types.js";
import { extractOpError } from "./engine-receipt.js";
import { WORLD_SNAPSHOT_FALLBACK } from "./engine-fallbacks.js";
import { normalizeNodePath, parentNodePath } from "./tscn.js";
import {
  applyMat3 as apply,
  basisFromEulerScale,
  IDENTITY3,
  mulMat3 as mul,
  parseVec3,
  transformLiteral,
  vec3Literal,
  type Mat3,
  type Vec3,
} from "./math3d.js";

export { basisFromEulerScale, parseVec3 };

export const INSPECT_NODE_DERIVED_FIELDS: readonly string[] = [
  "transform",
  "global_transform",
  "scene_file_path",
  "aabb",
  "warnings",
];
const SNAPSHOT_FIELDS = new Set(["global_transform", "scene_file_path", "aabb"]);

// Mirrors library/tools/inspect-node/resource.yaml input_schema (parity-tested).
export const inspectNodeInputShape = {
  path: z.string().describe("Node path from scene tree, e.g. 'Player', 'World/Enemies/Boss', 'DirectionalLight3D'"),
  fields: z
    .array(z.string())
    .max(48)
    .optional()
    .describe(
      "Only these fields: property names or globs (e.g. 'position', 'surface_material_override/*') and the derived fields transform, global_transform, scene_file_path, aabb, warnings. Omit for every property."
    ),
};

export const inspectNodeInputSchema = z.object(inspectNodeInputShape).strict();
export type InspectNodeArgs = z.infer<typeof inspectNodeInputSchema>;

export interface InspectNodeClient extends CapabilityAdvertisingClient {
  inspectNode(path: string): Promise<unknown>;
  executeOps(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

// ---------------------------------------------------------------------------

function propsOf(payload: unknown): JsonRecord[] {
  const data = asRecord(asRecord(payload)?.data);
  const props = data?.props;
  return Array.isArray(props) ? (props.filter((p) => asRecord(p)) as JsonRecord[]) : [];
}

function globMatcher(pattern: string): (name: string) => boolean {
  if (!/[*?]/.test(pattern)) return (name) => name === pattern;
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return (name) => regex.test(name);
}

function localTransformFromProps(props: JsonRecord[]): JsonRecord | null {
  const value = (name: string) => props.find((p) => p.name === name)?.value;
  const position = parseVec3(value("position"));
  const rotation = parseVec3(value("rotation"));
  const scale = parseVec3(value("scale"));
  if (position && rotation && scale) {
    const rotDeg = rotation.map((r) => (r * 180) / Math.PI) as Vec3;
    const out: JsonRecord = {
      position: vec3Literal(position),
      rotation_degrees: vec3Literal(rotDeg),
      scale: vec3Literal(scale),
      source: "inspector (rotation read in radians at 3 decimals)",
    };
    const order = value("rotation_order");
    if (order === undefined || order === 2) out.transform = transformLiteral(basisFromEulerScale(rotDeg, scale), position);
    else out.rotation_order = order;
    return out;
  }
  // 2D / Control: report what the inspector has.
  const out: JsonRecord = {};
  for (const name of ["position", "rotation", "scale", "skew", "size"]) {
    const v = value(name);
    if (v !== undefined) out[name] = v;
  }
  return Object.keys(out).length > 0 ? { ...out, source: "inspector" } : null;
}

export interface SnapshotNode {
  pos?: Vec3;
  rot?: Vec3;
  scale?: Vec3;
  entry: JsonRecord;
}

async function snapshotIndex(client: InspectNodeClient): Promise<Map<string, SnapshotNode> | { error: string }> {
  const missing = missingEngineOpResult(client, "GetWorldSnapshot", WORLD_SNAPSHOT_FALLBACK);
  if (missing) return { error: missing.error };
  let result: unknown;
  try {
    result = await client.executeOps([{ op: "GetWorldSnapshot" }]);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const failure = extractOpError(result);
  if (failure) return { error: failure };
  const root = asRecord(result);
  const payload = Array.isArray(root?.nodes)
    ? root
    : asRecord((Array.isArray(root?.results) ? root!.results : []).find((r) => asRecord(r)?.op === "GetWorldSnapshot"));
  const nodes = Array.isArray(payload?.nodes) ? payload!.nodes : null;
  if (!nodes) return { error: "the world snapshot returned no node list" };
  const index = new Map<string, SnapshotNode>();
  for (const raw of nodes) {
    const entry = asRecord(raw);
    if (!entry || typeof entry.path !== "string") continue;
    index.set(normalizeNodePath(entry.path), {
      pos: parseVec3(entry.pos) ?? undefined,
      rot: parseVec3(entry.rot_deg) ?? undefined,
      scale: parseVec3(entry.scale) ?? undefined,
      entry,
    });
  }
  return index;
}

function hasTransform(node: SnapshotNode | undefined): node is Required<Pick<SnapshotNode, "pos" | "rot" | "scale">> & SnapshotNode {
  return !!node && !!node.pos && !!node.rot && !!node.scale;
}

/** World transform of a Node3D: its local transform composed with every
 *  Node3D directly above it. A Node3D's parent space ends at the first
 *  ancestor that is not a Node3D (a plain Node or a CanvasItem — the snapshot
 *  lists CanvasItems only with include_2d), as in Godot. */
export function globalTransform(index: Map<string, SnapshotNode>, path: string): JsonRecord | { error: string } {
  const target = index.get(path);
  if (!target) return { error: `the world snapshot does not list ${path} (a 2D node, or the scene is larger than the snapshot cap)` };
  if (!hasTransform(target)) return { error: `${path} is not a 3D node` };
  const chain: SnapshotNode[] = [target];
  for (let p = parentNodePath(path); p !== null; p = parentNodePath(p)) {
    const node = index.get(p);
    if (!hasTransform(node)) break;
    chain.unshift(node);
  }
  let basis: Mat3 = IDENTITY3;
  let origin: Vec3 = [0, 0, 0];
  for (const node of chain) {
    const local = basisFromEulerScale(node.rot!, node.scale!);
    const moved = apply(basis, node.pos!);
    origin = [moved[0] + origin[0], moved[1] + origin[1], moved[2] + origin[2]];
    basis = mul(basis, local);
  }
  return {
    origin: vec3Literal(origin),
    transform: transformLiteral(basis, origin),
    source: "composed from the world snapshot's local pos/rot_deg/scale down the parent chain (YXZ Euler; top_level nodes not detected)",
  };
}

export async function inspectNodeFields(client: InspectNodeClient, args: InspectNodeArgs): Promise<unknown> {
  const payload = annotateVariantTypes(await client.inspectNode(args.path));
  if (!args.fields || args.fields.length === 0) return payload;
  if (extractOpError(payload)) return payload;
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  if (!root || !data) return payload;

  const props = propsOf(payload);
  const requested = args.fields;
  const derived = requested.filter((f) => INSPECT_NODE_DERIVED_FIELDS.includes(f));
  const propPatterns = requested.filter((f) => !INSPECT_NODE_DERIVED_FIELDS.includes(f)).map(globMatcher);
  const keptProps = props.filter((p) => propPatterns.some((match) => match(String(p.name ?? ""))));
  const missing = requested
    .filter((f) => !INSPECT_NODE_DERIVED_FIELDS.includes(f))
    .filter((f) => !props.some((p) => globMatcher(f)(String(p.name ?? ""))));

  const out: JsonRecord = {
    node_path: data.node_path,
    node_type: data.node_type,
    node_name: data.node_name,
    ...(keptProps.length > 0 ? { props: keptProps } : {}),
  };
  const unavailable: Record<string, string> = {};

  if (derived.includes("transform")) {
    const local = localTransformFromProps(props);
    if (local) out.transform = local;
    else unavailable.transform = "this node has no position/rotation/scale (not a Node3D, Node2D or Control)";
  }
  if (derived.includes("warnings")) out.warnings = Array.isArray(data.warnings) ? data.warnings : [];

  if (derived.some((f) => SNAPSHOT_FIELDS.has(f))) {
    const nodePath = normalizeNodePath(String(data.node_path ?? args.path));
    const index = await snapshotIndex(client);
    if (!(index instanceof Map)) {
      for (const f of derived.filter((d) => SNAPSHOT_FIELDS.has(d))) unavailable[f] = `world snapshot unavailable: ${index.error}`;
    } else {
      const map = index;
      const node = map.get(nodePath);
      if (derived.includes("scene_file_path")) {
        if (node) out.scene_file_path = typeof node.entry.scene_file === "string" ? node.entry.scene_file : null;
        else unavailable.scene_file_path = `the world snapshot does not list ${nodePath}`;
      }
      if (derived.includes("aabb")) {
        if (node?.entry.aabb) out.aabb = node.entry.aabb;
        else unavailable.aabb = node ? "the node has no visual bounds" : `the world snapshot does not list ${nodePath}`;
      }
      if (derived.includes("global_transform")) {
        const global = globalTransform(map, nodePath);
        if ("error" in global && typeof global.error === "string") unavailable.global_transform = global.error;
        else out.global_transform = global;
      }
    }
  }

  if (missing.length > 0) out.missing_fields = missing;
  if (Object.keys(unavailable).length > 0) out.unavailable = unavailable;
  return { ...root, data: out };
}
