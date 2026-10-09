import { describe, expect, it } from "vitest";
import {
  angleDegrees,
  basisInverse,
  basisMul,
  basisMulVec,
  godotNumber,
  IDENTITY_BASIS,
  parseGodotTransform,
  parseGodotVector3,
  rotationAbout,
  rotationBetween,
  rotationFromFrames,
  signedAxisVector,
  toGodotTransform,
  toGodotVector3,
  xformCompose,
  xformInverse,
  xformMulPoint,
  type Basis3,
  type Vec3,
  type Xform,
} from "./placement-math.js";

function expectVec(actual: Vec3, expected: Vec3, digits = 6) {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, digits));
}

function expectBasis(actual: Basis3, expected: Basis3) {
  actual.forEach((column, i) => expectVec(column, expected[i]!));
}

describe("placement math", () => {
  it("rotates +x to -z with a +90 degree turn about +y (Godot's right-handed convention)", () => {
    const r = rotationAbout([0, 1, 0], Math.PI / 2);
    expectVec(basisMulVec(r, [1, 0, 0]), [0, 0, -1]);
    expectVec(basisMulVec(r, [0, 0, 1]), [1, 0, 0]);
  });

  it("finds the shortest rotation between directions, including opposite ones", () => {
    expectVec(basisMulVec(rotationBetween([1, 0, 0], [0, 0, 1]), [1, 0, 0]), [0, 0, 1]);
    const flip = rotationBetween([0, 0, 1], [0, 0, -1], [0, 1, 0]);
    expectVec(basisMulVec(flip, [0, 0, 1]), [0, 0, -1]);
    // The half turn is about the fallback axis, so up stays up.
    expectVec(basisMulVec(flip, [0, 1, 0]), [0, 1, 0]);
    expectBasis(rotationBetween([0, 1, 0], [0, 1, 0]), IDENTITY_BASIS);
  });

  it("maps a local back/up frame onto a world frame", () => {
    // Back -z faces into a wall whose normal is +x: world back = -x. Up stays up.
    const r = rotationFromFrames(signedAxisVector("-z"), signedAxisVector("+y"), [-1, 0, 0], [0, 1, 0]);
    expectVec(basisMulVec(r, [0, 0, -1]), [-1, 0, 0]);
    expectVec(basisMulVec(r, [0, 1, 0]), [0, 1, 0]);
    expect(Math.abs(basisMulVec(r, [1, 0, 0])[2])).toBeCloseTo(1);
  });

  it("inverts transforms with non-uniform scale", () => {
    const t: Xform = {
      basis: basisMul(rotationAbout([0, 1, 0], 0.7), [
        [2, 0, 0],
        [0, 0.5, 0],
        [0, 0, 3],
      ]),
      origin: [4, -1, 2],
    };
    const p: Vec3 = [0.3, 1.2, -5];
    expectVec(xformMulPoint(xformInverse(t), xformMulPoint(t, p)), p);
    expectBasis(basisMul(basisInverse(t.basis), t.basis), IDENTITY_BASIS);
    const both = xformCompose(xformInverse(t), t);
    expectBasis(both.basis, IDENTITY_BASIS);
    expectVec(both.origin, [0, 0, 0]);
  });

  it("formats Godot variant strings without exponent notation and parses them back", () => {
    expect(godotNumber(0.000001)).toBe("0.000001");
    expect(godotNumber(1e-9)).toBe("0");
    expect(godotNumber(-0)).toBe("0");
    expect(godotNumber(12.5)).toBe("12.5");
    expect(toGodotVector3([1, -2.25, 0])).toBe("Vector3(1, -2.25, 0)");
    expect(parseGodotVector3("Vector3(1, -2.25, 3e-2)")).toEqual([1, -2.25, 0.03]);
    expect(parseGodotVector3("Vector3(1, 2)")).toBeNull();
  });

  it("writes Transform3D row-major like Godot's variant writer", () => {
    // +90 degrees about y: basis.x = (0, 0, -1), basis.z = (1, 0, 0).
    const t: Xform = { basis: rotationAbout([0, 1, 0], Math.PI / 2), origin: [1, 2, 3] };
    expect(toGodotTransform(t)).toBe("Transform3D(0, 0, 1, 0, 1, 0, -1, 0, 0, 1, 2, 3)");
    const parsed = parseGodotTransform(toGodotTransform(t))!;
    expectBasis(parsed.basis, t.basis);
    expectVec(parsed.origin, [1, 2, 3]);
    // The kit's own .tscn line round-trips to the same basis.
    const kit = parseGodotTransform("Transform3D(-0.000000, 0, -1.000000, 0, 1, 0, 1.000000, 0, -0.000000, 0, 0, 0)")!;
    expectVec(kit.basis[0], [0, 0, 1]);
    expectVec(kit.basis[2], [-1, 0, 0]);
    expect(parseGodotTransform("Transform3D(1, 0, 0)")).toBeNull();
  });

  it("measures angles between directions", () => {
    expect(angleDegrees([1, 0, 0], [0, 1, 0])).toBeCloseTo(90);
    expect(angleDegrees([0, 0, 1], [0, 0, -2])).toBeCloseTo(180);
  });
});
