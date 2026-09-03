import { describe, expect, it } from "vitest";
import { VARIANT_TYPE_NAMES, annotateVariantTypes, variantTypeName } from "./variant-types.js";

describe("variantTypeName — Godot 4.x Variant::Type order (core/variant/variant.h)", () => {
  it("covers exactly VARIANT_MAX (39) entries", () => {
    expect(VARIANT_TYPE_NAMES).toHaveLength(39);
    expect(new Set(VARIANT_TYPE_NAMES).size).toBe(39);
  });

  it.each([
    [0, "TYPE_NIL"],
    [1, "TYPE_BOOL"],
    [2, "TYPE_INT"],
    [3, "TYPE_FLOAT"],
    [4, "TYPE_STRING"],
    [5, "TYPE_VECTOR2"],
    [9, "TYPE_VECTOR3"],
    [11, "TYPE_TRANSFORM2D"],
    [18, "TYPE_TRANSFORM3D"],
    [19, "TYPE_PROJECTION"],
    [20, "TYPE_COLOR"],
    [22, "TYPE_NODE_PATH"],
    [24, "TYPE_OBJECT"],
    [27, "TYPE_DICTIONARY"],
    [28, "TYPE_ARRAY"],
    [29, "TYPE_PACKED_BYTE_ARRAY"],
    [38, "TYPE_PACKED_VECTOR4_ARRAY"],
  ])("maps %i to %s", (value, name) => {
    expect(variantTypeName(value)).toBe(name);
  });

  it("returns undefined outside the table and for non-integers", () => {
    expect(variantTypeName(39)).toBeUndefined();
    expect(variantTypeName(-1)).toBeUndefined();
    expect(variantTypeName(2.5)).toBeUndefined();
    expect(variantTypeName("2")).toBeUndefined();
    expect(variantTypeName(undefined)).toBeUndefined();
  });
});

describe("annotateVariantTypes — inspector payload", () => {
  // Shape of /api/state/inspector as the E2E run received it (F-14).
  const payload = {
    ok: true,
    data: {
      node_name: "Ground",
      node_type: "StaticBody2D",
      node_path: "Geometry/Ground",
      props: [
        { name: "position", type: 5, value: "(0, 0)" },
        { name: "collision_layer", type: 2, value: 1 },
        { name: "modulate", type: 20, value: "(1, 1, 1, 1)" },
        { name: "script", type: 24, value: null, resource_type: "GDScript" },
        { name: "future", type: 99, value: null },
      ],
      warnings: [],
    },
  };

  it("adds type_name next to every known integer type and keeps the integer", () => {
    const out = annotateVariantTypes(payload);
    const props = out.data.props as Array<Record<string, unknown>>;
    expect(props[0]).toEqual({ name: "position", type: 5, type_name: "TYPE_VECTOR2", value: "(0, 0)" });
    expect(Object.keys(props[0])).toEqual(["name", "type", "type_name", "value"]);
    expect(props[1].type_name).toBe("TYPE_INT");
    expect(props[2].type_name).toBe("TYPE_COLOR");
    expect(props[3]).toMatchObject({ type: 24, type_name: "TYPE_OBJECT", resource_type: "GDScript" });
  });

  it("leaves unknown type integers without a type_name rather than guessing", () => {
    const out = annotateVariantTypes(payload);
    const props = out.data.props as Array<Record<string, unknown>>;
    expect(props[4]).toEqual({ name: "future", type: 99, value: null });
  });

  it("does not mutate the input", () => {
    const before = JSON.stringify(payload);
    annotateVariantTypes(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it("also handles a top-level props list and passes other shapes through", () => {
    const flat = annotateVariantTypes({ props: [{ name: "x", type: 3, value: 1.5 }] });
    expect((flat.props[0] as Record<string, unknown>).type_name).toBe("TYPE_FLOAT");
    expect(annotateVariantTypes(null)).toBeNull();
    expect(annotateVariantTypes("node not found: X")).toBe("node not found: X");
    expect(annotateVariantTypes({ ok: false, error: "node not found: X" })).toEqual({
      ok: false,
      error: "node not found: X",
    });
    expect(annotateVariantTypes([1, 2])).toEqual([1, 2]);
  });
});
