/**
 * Godot Variant.Type names for the raw integers the engine's inspector
 * endpoint returns (E2E 2026-09-03 F-14: `summer_inspect_node` props carry
 * `type: 2`, `type: 20`, ... — StateProvider writes `pd["type"] = pi.type`, the
 * Variant::Type enum value, and nothing else).
 *
 * Order verified against summerengine core/variant/variant.h `enum Type`
 * (Godot 4.x; VARIANT_MAX = 39). Names are the @GlobalScope `TYPE_*` constants
 * agents see in GDScript (`typeof()`, `Variant.Type`), so a reader can match
 * them against the class reference without a lookup table.
 */
export const VARIANT_TYPE_NAMES: readonly string[] = [
  "TYPE_NIL", // 0
  // atomic types
  "TYPE_BOOL", // 1
  "TYPE_INT", // 2
  "TYPE_FLOAT", // 3
  "TYPE_STRING", // 4
  // math types
  "TYPE_VECTOR2", // 5
  "TYPE_VECTOR2I", // 6
  "TYPE_RECT2", // 7
  "TYPE_RECT2I", // 8
  "TYPE_VECTOR3", // 9
  "TYPE_VECTOR3I", // 10
  "TYPE_TRANSFORM2D", // 11
  "TYPE_VECTOR4", // 12
  "TYPE_VECTOR4I", // 13
  "TYPE_PLANE", // 14
  "TYPE_QUATERNION", // 15
  "TYPE_AABB", // 16
  "TYPE_BASIS", // 17
  "TYPE_TRANSFORM3D", // 18
  "TYPE_PROJECTION", // 19
  // misc types
  "TYPE_COLOR", // 20
  "TYPE_STRING_NAME", // 21
  "TYPE_NODE_PATH", // 22
  "TYPE_RID", // 23
  "TYPE_OBJECT", // 24
  "TYPE_CALLABLE", // 25
  "TYPE_SIGNAL", // 26
  "TYPE_DICTIONARY", // 27
  "TYPE_ARRAY", // 28
  // typed arrays
  "TYPE_PACKED_BYTE_ARRAY", // 29
  "TYPE_PACKED_INT32_ARRAY", // 30
  "TYPE_PACKED_INT64_ARRAY", // 31
  "TYPE_PACKED_FLOAT32_ARRAY", // 32
  "TYPE_PACKED_FLOAT64_ARRAY", // 33
  "TYPE_PACKED_STRING_ARRAY", // 34
  "TYPE_PACKED_VECTOR2_ARRAY", // 35
  "TYPE_PACKED_VECTOR3_ARRAY", // 36
  "TYPE_PACKED_COLOR_ARRAY", // 37
  "TYPE_PACKED_VECTOR4_ARRAY", // 38
];

/** `TYPE_*` name for a Variant.Type integer; undefined for anything outside
 *  the table (a future engine enum, or a value that was never a type). */
export function variantTypeName(type: unknown): string | undefined {
  if (typeof type !== "number" || !Number.isInteger(type)) return undefined;
  return VARIANT_TYPE_NAMES[type];
}

/**
 * Add `type_name` next to every integer `type` in an inspector payload's
 * `props` list (top level or under `data`), keeping the integer. Shape-
 * tolerant: anything that is not the expected shape passes through untouched,
 * and the input is never mutated.
 */
export function annotateVariantTypes<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const root = payload as Record<string, unknown>;
  const out: Record<string, unknown> = { ...root };
  if (Array.isArray(root.props)) out.props = annotateProps(root.props);
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
    const data = root.data as Record<string, unknown>;
    if (Array.isArray(data.props)) out.data = { ...data, props: annotateProps(data.props) };
  }
  return out as T;
}

function annotateProps(props: unknown[]): unknown[] {
  return props.map((prop) => {
    if (!prop || typeof prop !== "object" || Array.isArray(prop)) return prop;
    const record = prop as Record<string, unknown>;
    const name = variantTypeName(record.type);
    if (!name || typeof record.type_name === "string") return prop;
    // Insert type_name right after type so the pair reads together.
    const annotated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      annotated[key] = value;
      if (key === "type") annotated.type_name = name;
    }
    return annotated;
  });
}
