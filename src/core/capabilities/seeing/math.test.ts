import { describe, expect, it } from "vitest";
import {
  applyLowAngleRule,
  directionFromAngles,
  exactCrop,
  fitDistance,
  formatVector3,
  frameFill,
  horizonV,
  letterbox,
  lookAtBasis,
  parseVector3,
  project,
  rayDirection,
  rotateY,
  screenBox,
  thirdsYawOffset,
  type Aabb,
  type CameraPose,
} from "./math.js";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("seeing math — engine conventions", () => {
  it("lookAtBasis matches Basis.looking_at: -Z forward, +Y up, +X right", () => {
    const b = lookAtBasis([0, 0, 0], [0, 0, -5]);
    expect(b.z.map((v) => Math.round(v) + 0)).toEqual([0, 0, 1]);
    expect(b.x.map((v) => Math.round(v) + 0)).toEqual([1, 0, 0]);
    expect(b.y.map((v) => Math.round(v) + 0)).toEqual([0, 1, 0]);
  });

  it("uses the engine's -Z up guard when looking straight down", () => {
    const b = lookAtBasis([0, 10, 0], [0, 0, 0]);
    expect(Number.isFinite(b.x[0])).toBe(true);
    close(b.z[1], 1);
  });

  it("project and rayDirection are inverse through the screen", () => {
    const pose: CameraPose = { position: [3, 4, 10], look_at: [0, 1, 0], fov: 55 };
    for (const [u, v] of [[0.5, 0.5], [0.1, 0.2], [0.9, 0.8]] as const) {
      const dir = rayDirection(pose, 16 / 9, u, v);
      const point = [pose.position[0] + dir[0] * 7, pose.position[1] + dir[1] * 7, pose.position[2] + dir[2] * 7] as const;
      const p = project(pose, 16 / 9, point);
      close(p.u, u, 1e-9);
      close(p.v, v, 1e-9);
      expect(p.depth).toBeGreaterThan(0);
    }
  });

  it("puts v = 0 at the top of the image", () => {
    const pose: CameraPose = { position: [0, 0, 10], look_at: [0, 0, 0], fov: 60 };
    expect(project(pose, 1, [0, 2, 0]).v).toBeLessThan(0.5);
    expect(project(pose, 1, [2, 0, 0]).u).toBeGreaterThan(0.5);
  });

  it("fitDistance lands the subject at the requested frame share", () => {
    const box: Aabb = { position: [-10, 0, -2], size: [20, 8, 4] };
    const center = [0, 4, 0] as const;
    for (const fill of [0.5, 0.8]) {
      const toCam = directionFromAngles(20, 15);
      const d = fitDistance(box, center, toCam, 55, 16 / 9, fill);
      const pose: CameraPose = { position: [center[0] + toCam[0] * d, center[1] + toCam[1] * d, center[2] + toCam[2] * d], look_at: center, fov: 55 };
      close(frameFill(pose, 16 / 9, box), fill, 1e-3);
    }
  });

  it("screenBox reports corners behind the lens instead of a bogus box", () => {
    const pose: CameraPose = { position: [0, 1, 0], look_at: [0, 1, -1], fov: 60 };
    const s = screenBox(pose, 1, { position: [-1, 0, -1], size: [2, 2, 3] });
    expect(s.anyBehind).toBe(true);
    expect(frameFill(pose, 1, { position: [-1, 0, -1], size: [2, 2, 3] })).toBe(Infinity);
  });

  it("the low-angle rule moves closer and widens the fov instead of burying the camera", () => {
    const look = [0, 4, 0] as const;
    const toCam = directionFromAngles(0, -15);
    const r = applyLowAngleRule(look, toCam, 30, 60, 0.35, 100);
    expect(r.adjusted).toBe(true);
    close(r.position[1], 0.35, 1e-9);
    expect(r.distance).toBeLessThan(30);
    expect(r.fov).toBeGreaterThan(60);
    expect(r.fov).toBeLessThanOrEqual(100);
    // A camera that is already above the ground is left alone.
    expect(applyLowAngleRule(look, directionFromAngles(0, 20), 30, 60, 0.35, 100).adjusted).toBe(false);
    // A look-at point under the clearance cannot be shot from below.
    expect(applyLowAngleRule([0, 0.1, 0], toCam, 30, 60, 0.35, 100).impossible).toBe(true);
  });

  it("exactCrop honours the region (regression: a 0.3 x 0.6 region came back x1.3, grown to 16:9 and padded)", () => {
    const exact = exactCrop({ u0: 0.5, v0: 0.15, u1: 0.8, v1: 0.75 });
    expect(exact.crop).toEqual([0.5, 0.15, 0.8, 0.75]);
    expect(exact.widenedBecause).toEqual([]);
    // A pad is the only thing that widens it, and it is named; the frame edge clips it.
    const padded = exactCrop({ u0: 0.9, v0: 0.4, u1: 1, v1: 0.5 }, 0.15);
    close(padded.crop[0], 0.885, 1e-9);
    expect(padded.crop[2]).toBe(1);
    expect(padded.clipped).toBe(true);
    expect(padded.widenedBecause[0]).toMatch(/pad 0\.15/);
  });

  it("letterbox keeps the region's aspect: the image takes it, bars only past the clamp", () => {
    // 0.3 x 0.6 of a 16:9 frame is 0.889:1 in pixels.
    const tall = letterbox((0.3 / 0.6) * (16 / 9), 1024);
    expect(tall.letterboxed).toBe(false);
    close(tall.rect[2] / tall.rect[3], 0.889, 0.01);
    expect(Math.max(...tall.canvas)).toBe(1024);
    // A thin strip keeps its aspect inside a clamped canvas with bars.
    const strip = letterbox(10, 1024);
    expect(strip.letterboxed).toBe(true);
    close(strip.rect[2] / strip.rect[3], 10, 0.3);
    expect(strip.rect[2]).toBeLessThanOrEqual(strip.canvas[0]);
  });

  it("horizon, thirds and rotation helpers", () => {
    close(horizonV(0, 60)!, 0.5);
    expect(horizonV(80, 60)).toBeNull();
    expect(thirdsYawOffset(60, 16 / 9)).toBeGreaterThan(10);
    const r = rotateY([0, 0, 1], 90);
    close(r[0], 1);
    close(r[2], 0, 1e-9);
  });
});

describe("parseVector3 / formatVector3", () => {
  it("round-trips Godot literals", () => {
    expect(parseVector3("Vector3(1, -2.5, 3e1)", "p")).toEqual([1, -2.5, 30]);
    expect(formatVector3([1.23456, -0, 2])).toBe("Vector3(1.235, 0, 2)");
  });

  it.each([
    ["{x: 1, y: 2, z: 3}"],
    ["Vector3(1, 2)"],
    ['Vector3(1, 2, 3)"); OS.execute("rm'],
    ["Vector3(1, 2, 3)\nprint(1)"],
    ["Vector3($&, 1, 2)"],
  ])("refuses hostile or malformed input %j", (literal) => {
    expect(() => parseVector3(literal, "camera_position")).toThrow(/Nothing was sent/);
  });
});
