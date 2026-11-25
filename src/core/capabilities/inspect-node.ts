/**
 * inspect-node — ONE implementation of `summer_inspect_node` for both faces
 * (src/mcp/tools/scene-tools.ts and tool-dispatch.ts).
 *
 * The engine's state:inspector returns every editor-visible property of a
 * node (StateProvider::inspector_state) — about 5 KB to read one transform.
 * `fields` keeps only the named properties (globs allowed) and adds a few
 * derived fields the inspector cannot give:
 *   transform        local position and scale, rotation in radians on Node2D and
 *                    Control, rotation_degrees and a Transform3D literal on Node3D;
 *   global_transform exact native scene transform, respecting Node3D inheritance;
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
import { normalizeNodePath } from "./tscn.js";
import { readSceneNodeTransform } from "./scene-space.js";

export const INSPECT_NODE_DERIVED_FIELDS: readonly string[] = [
  "transform",
  "global_transform",
  "scene_file_path",
  "aabb",
  "warnings",
];
const SNAPSHOT_FIELDS = new Set(["scene_file_path", "aabb"]);

// Mirrors library/tools/inspect-node/resource.yaml input_schema (parity-tested).
export const inspectNodeInputShape = {
  path: z.string().describe("Node path from scene tree, e.g. 'Player', 'World/Enemies/Boss', 'DirectionalLight3D'"),
  fields: z
    .array(z.string())
    .max(48)
    .optional()
    .describe(
      "Only these fields: property names or globs (e.g. 'position', 'surface_material_override/*') and the derived fields transform, global_transform, scene_file_path, aabb, warnings. In transform, Node2D and Control report rotation in radians. Node3D reports rotation_degrees. Omit for every property."
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

function canvasTransformFromProps(props: JsonRecord[]): JsonRecord | null {
  const value = (name: string) => props.find((p) => p.name === name)?.value;
  const out: JsonRecord = {};
  for (const name of ["position", "rotation", "scale", "skew", "size"]) {
    const v = value(name);
    if (v !== undefined) out[name] = v;
  }
  return Object.keys(out).length > 0 ? { ...out, source: "inspector" } : null;
}

async function snapshotIndex(client: InspectNodeClient): Promise<Map<string, JsonRecord> | { error: string }> {
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
  const index = new Map<string, JsonRecord>();
  for (const raw of nodes) {
    const entry = asRecord(raw);
    if (!entry || typeof entry.path !== "string") continue;
    index.set(normalizeNodePath(entry.path), entry);
  }
  return index;
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

  const wantsLocal = derived.includes("transform");
  const wantsWorld = derived.includes("global_transform");
  const has3DPosition = props.some((p) => p.name === "position" && p.type_name === "TYPE_VECTOR3");
  if (wantsLocal && !has3DPosition) {
    const local = canvasTransformFromProps(props);
    if (local) out.transform = local;
    else unavailable.transform = "this node has no position/rotation/scale (not a Node3D, Node2D or Control)";
  }
  if (wantsWorld || (wantsLocal && has3DPosition)) {
    const nodePath = normalizeNodePath(String(data.node_path ?? args.path));
    const scenePath = asRecord(root.provenance)?.scenePath;
    const native = await readSceneNodeTransform(client, nodePath, typeof scenePath === "string" && scenePath ? scenePath : undefined);
    if (wantsLocal && has3DPosition) {
      if ("error" in native) unavailable.transform = native.error;
      else out.transform = { ...native.local, source: "native Node3D local transform" };
    }
    if (wantsWorld) {
      if ("error" in native) unavailable.global_transform = native.error;
      else out.global_transform = {
        origin: native.worldOrigin,
        transform: native.transform,
        source: "native scene transform (Node3D inheritance, top_level and rotation order respected)",
      };
    }
  }
  if (derived.includes("warnings")) out.warnings = Array.isArray(data.warnings) ? data.warnings : [];

  if (derived.some((f) => SNAPSHOT_FIELDS.has(f))) {
    const nodePath = normalizeNodePath(String(data.node_path ?? args.path));
    const index = await snapshotIndex(client);
    if (!(index instanceof Map)) {
      for (const f of derived.filter((d) => SNAPSHOT_FIELDS.has(d))) unavailable[f] = `world snapshot unavailable: ${index.error}`;
    } else {
      const node = index.get(nodePath);
      if (derived.includes("scene_file_path")) {
        if (node) out.scene_file_path = typeof node.scene_file === "string" ? node.scene_file : null;
        else unavailable.scene_file_path = `the world snapshot does not list ${nodePath}`;
      }
      if (derived.includes("aabb")) {
        if (node?.aabb) out.aabb = node.aabb;
        else unavailable.aabb = node ? "the node has no visual bounds" : `the world snapshot does not list ${nodePath}`;
      }
    }
  }

  if (missing.length > 0) out.missing_fields = missing;
  if (Object.keys(unavailable).length > 0) out.unavailable = unavailable;
  return { ...root, data: out };
}
