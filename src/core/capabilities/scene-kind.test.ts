import { afterEach, describe, expect, it } from "vitest";
import { isApiDocsBundleInstalled, resetApiDocsForTests } from "./api-docs.js";
import {
  classifySceneKindFromTree,
  isCanvasItemClass,
  isNode3DClass,
  resetSceneKindCacheForTests,
} from "./scene-kind.js";

afterEach(() => {
  resetApiDocsForTests();
  resetSceneKindCacheForTests();
});

function tree(rootClass: string, children: Array<Record<string, unknown>> = []) {
  return {
    ok: true,
    activeTab: "3D", // the engine reports the editor tab, not the scene kind (F-17) — must be ignored
    data: { name: "Root", class: rootClass, path: ".", children },
  };
}

const node = (cls: string, children: Array<Record<string, unknown>> = []) => ({ name: cls, class: cls, path: cls, children });

describe("classifySceneKindFromTree (bundled class reference)", () => {
  it("has the api-docs bundle available in this checkout", () => {
    expect(isApiDocsBundleInstalled()).toBe(true);
  });

  it("the e2e 2D room (Node2D root, Polygon2D geometry, Control HUD) is 2d", () => {
    const state = tree("Node2D", [
      node("ParallaxBackground"),
      node("Marker2D"),
      node("StaticBody2D", [node("Polygon2D"), node("CollisionPolygon2D")]),
      node("CanvasLayer", [node("Control", [node("Label")])]),
      node("Label"),
    ]);
    expect(classifySceneKindFromTree(state)).toEqual({ kind: "2d", classesSeen: 9 });
  });

  it("any Node3D anywhere makes the scene 3d, even with a plain Node root and 2D UI present", () => {
    const state = tree("Node", [
      node("CanvasLayer", [node("Label")]),
      node("Node", [node("Node", [node("Decal")])]), // Node3D subclass without a 3D suffix
    ]);
    expect(classifySceneKindFromTree(state).kind).toBe("3d");
  });

  it("a tree of plain Nodes is neither", () => {
    expect(classifySceneKindFromTree(tree("Node", [node("Node"), node("Timer"), node("AudioStreamPlayer")])).kind).toBe(
      "none"
    );
  });

  it("carries the truncation flag through", () => {
    const state = { ...tree("Node3D"), truncated: true };
    expect(classifySceneKindFromTree(state)).toEqual({ kind: "3d", classesSeen: 1, truncated: true });
  });

  it("is unknown when the read carries no tree, keeping the engine's error", () => {
    expect(classifySceneKindFromTree({ ok: false, error: "scene not loaded" })).toEqual({
      kind: "unknown",
      reason: "scene not loaded",
    });
    expect(classifySceneKindFromTree(null).kind).toBe("unknown");
    expect(classifySceneKindFromTree("nope").kind).toBe("unknown");
  });

  it("treats a custom/plugin class as neither kind (no false warning)", () => {
    expect(classifySceneKindFromTree(tree("Node", [node("MyPluginThing")])).kind).toBe("none");
  });
});

describe("class predicates without the api-docs bundle (suffix heuristic)", () => {
  it("falls back to the suffix and the no-suffix Node3D list", () => {
    resetApiDocsForTests("/definitely/not/here/api-docs.json.gz");
    resetSceneKindCacheForTests();
    expect(isApiDocsBundleInstalled()).toBe(false);
    expect(isNode3DClass("MeshInstance3D")).toBe(true);
    expect(isNode3DClass("GridMap")).toBe(true);
    expect(isNode3DClass("Polygon2D")).toBe(false);
    expect(isNode3DClass("Label")).toBe(false);
    expect(isCanvasItemClass("Polygon2D")).toBe(true);
    expect(isCanvasItemClass("Label")).toBe(true);
    expect(isCanvasItemClass("WorldEnvironment")).toBe(false);
    expect(classifySceneKindFromTree(tree("Node2D", [node("Sprite2D")])).kind).toBe("2d");
    expect(classifySceneKindFromTree(tree("Node3D", [node("Camera3D")])).kind).toBe("3d");
  });
});
