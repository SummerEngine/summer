import { describe, expect, it } from "vitest";
import { viewSetOp } from "./view-set.js";
import { legacyNames } from "../ops/contract.js";
import { ENGINE_OPS } from "../ops/engine.js";

describe("summer_view_set / engine.view_set (PRODUCT-SPEC J17)", () => {
  it("is the engine's Navigate op, target view", () => {
    expect(viewSetOp({ view: "3d", rail: "scene", focus: "Track/Trees" })).toEqual({
      op: "Navigate",
      target: "view",
      name: "3d",
      tab: "scene",
      path: "Track/Trees",
    });
    expect(viewSetOp({ view: "game" })).toEqual({ op: "Navigate", target: "view", name: "game" });
  });

  it("is in the operation catalog under its 3.x name", () => {
    expect(ENGINE_OPS["engine.view_set"]?.effect).toBe("write");
    expect(legacyNames()["summer_view_set"]?.op).toBe("engine.view_set");
  });
});
