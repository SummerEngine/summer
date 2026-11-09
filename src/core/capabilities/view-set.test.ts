import { describe, expect, it } from "vitest";
import { viewSetOp } from "./view-set.js";
import { legacyNames } from "../ops/contract.js";
import { ENGINE_OPS } from "../ops/engine.js";

describe("summer_view_set / engine.view_set (PRODUCT-SPEC J17)", () => {
  it("is the engine's SetView op", () => {
    expect(viewSetOp({ view: "3d", rail: "scene", focus: "Track/Trees", frame: ["Track/Trees", "Track/Road"] })).toEqual({
      op: "SetView",
      view: "3d",
      rail: "scene",
      focus: "Track/Trees",
      frame: ["Track/Trees", "Track/Road"],
    });
    expect(viewSetOp({ view: "game" })).toEqual({ op: "SetView", view: "game" });
  });

  it("is in the operation catalog under its 3.x name", () => {
    expect(ENGINE_OPS["engine.view_set"]?.effect).toBe("write");
    expect(legacyNames()["summer_view_set"]?.op).toBe("engine.view_set");
  });
});
