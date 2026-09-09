/**
 * Is a scene 2D or 3D? Decided from a scene-tree read, the way the engine's
 * ScenePreview decides it (preview_ops.cpp `_scene_has_3d` / `_scene_has_2d`):
 * any Node3D anywhere in the tree makes the scene 3D; otherwise any CanvasItem
 * makes it 2D; a tree of plain Nodes is neither.
 *
 * Needed because the ScenePreview receipt reports `scene_has_camera` for BOTH
 * kinds (Camera3D in 3D scenes, Camera2D in 2D scenes) but never says which
 * kind it rendered, and the toolkit used to turn every `scene_has_camera:false`
 * into "no Camera3D — will render grey/black when played" (E2E 2026-09-03
 * F-05: false on a 2D room that played fine).
 *
 * Class ancestry comes from the bundled offline class reference
 * (assets/api-docs.json.gz, `inherits` chain) when it is installed; without it
 * a suffix heuristic plus the short list of Node3D subclasses that lack the
 * "3D" suffix is used. Either way an unknown class (plugin/custom) counts as
 * neither kind, so the failure direction is "no warning", never a false one.
 */
import { isApiDocsBundleInstalled, lookupApiDocs } from "./api-docs.js";

export type SceneKind = "3d" | "2d" | "none" | "unknown";

export interface SceneKindResult {
  kind: SceneKind;
  /** Why the kind is unknown (tree unreadable) — omitted otherwise. */
  reason?: string;
  /** Distinct node classes seen in the tree walk. */
  classesSeen?: number;
  /** The tree read declared itself truncated (depth/limit hit). */
  truncated?: boolean;
}

/** Node3D subclasses in Godot 4.7 whose names do not end in "3D" (from the
 *  bundled class reference). Fallback for installs without api-docs. */
const NODE3D_WITHOUT_SUFFIX = new Set([
  "Decal",
  "FogVolume",
  "GridMap",
  "LightmapGI",
  "LightmapProbe",
  "OpenXRCompositionLayer",
  "OpenXRCompositionLayerCylinder",
  "OpenXRCompositionLayerEquirect",
  "OpenXRCompositionLayerQuad",
  "OpenXRHand",
  "OpenXRRenderModel",
  "OpenXRRenderModelManager",
  "OpenXRVisibilityMask",
  "ReflectionProbe",
  "RootMotionView",
  "VoxelGI",
]);

const ancestryCache = new Map<string, string[]>();

/** Ancestor chain of a native class from the offline class reference, or null
 *  when the bundle is missing or does not know the class. */
function ancestry(className: string): string[] | null {
  if (!isApiDocsBundleInstalled()) return null;
  const cached = ancestryCache.get(className);
  if (cached) return cached;
  const chain: string[] = [];
  let current: string | null = className;
  let guard = 0;
  while (current && guard++ < 32) {
    const entry = lookupApiDocs(current) as { ok?: boolean; class?: string; inherits?: string | null };
    if (entry.ok === false || typeof entry !== "object") return null;
    chain.push(typeof entry.class === "string" ? entry.class : current);
    current = typeof entry.inherits === "string" ? entry.inherits : null;
  }
  ancestryCache.set(className, chain);
  return chain;
}

export function isNode3DClass(className: string): boolean {
  const chain = ancestry(className);
  if (chain) return chain.includes("Node3D");
  return /3D$/.test(className) || NODE3D_WITHOUT_SUFFIX.has(className);
}

export function isCanvasItemClass(className: string): boolean {
  const chain = ancestry(className);
  if (chain) return chain.includes("CanvasItem");
  return /2D$/.test(className) || isCanvasLikeName(className);
}

/** Common Control/CanvasItem classes without a 2D suffix — heuristic only. */
function isCanvasLikeName(className: string): boolean {
  return /^(Control|Container|Label|RichTextLabel|Button|TextureButton|CheckBox|CheckButton|OptionButton|MenuButton|LinkButton|Panel|PanelContainer|MarginContainer|VBoxContainer|HBoxContainer|GridContainer|CenterContainer|ScrollContainer|TabContainer|TextureRect|ColorRect|NinePatchRect|ProgressBar|TextureProgressBar|HSlider|VSlider|SpinBox|LineEdit|TextEdit|CodeEdit|ItemList|Tree|Popup|PopupMenu|PopupPanel|Window|SubViewportContainer|GraphEdit|GraphNode|VideoStreamPlayer|Range|BaseButton|Separator|HSeparator|VSeparator|SplitContainer|HSplitContainer|VSplitContainer|FlowContainer|HFlowContainer|VFlowContainer|AspectRatioContainer|ReferenceRect|MenuBar|TabBar|ScrollBar|HScrollBar|VScrollBar|ColorPicker|ColorPickerButton|FileDialog|AcceptDialog|ConfirmationDialog)$/.test(
    className
  );
}

interface TreeNode {
  class?: unknown;
  children?: unknown;
}

function collectClasses(node: unknown, out: Set<string>, budget: { left: number }): void {
  if (!node || typeof node !== "object" || budget.left <= 0) return;
  budget.left -= 1;
  const record = node as TreeNode;
  if (typeof record.class === "string" && record.class) out.add(record.class);
  if (Array.isArray(record.children)) {
    for (const child of record.children) collectClasses(child, out, budget);
  }
}

/** Find the tree root inside a scene-state envelope ({data:{name,class,children}}
 *  or the node itself). */
function findTreeRoot(sceneState: unknown): unknown {
  if (!sceneState || typeof sceneState !== "object") return null;
  const record = sceneState as Record<string, unknown>;
  if (typeof record.class === "string" && ("children" in record || "name" in record)) return record;
  for (const key of ["data", "tree", "scene", "root"]) {
    const inner = record[key];
    if (inner && typeof inner === "object") {
      const found = findTreeRoot(inner);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Classify a scene-tree read (`/api/state/scene`, summer_get_scene_tree) into
 * 3d / 2d / none, or unknown when the payload carries no tree.
 */
export function classifySceneKindFromTree(sceneState: unknown): SceneKindResult {
  const root = findTreeRoot(sceneState);
  if (!root) {
    const record = sceneState && typeof sceneState === "object" ? (sceneState as Record<string, unknown>) : null;
    const error = record && typeof record.error === "string" ? record.error : "scene tree read returned no tree";
    return { kind: "unknown", reason: error };
  }
  const classes = new Set<string>();
  collectClasses(root, classes, { left: 5000 });
  const envelope = sceneState as Record<string, unknown>;
  const truncated = envelope.truncated === true || (envelope.data as Record<string, unknown> | undefined)?.truncated === true;

  let has3d = false;
  let has2d = false;
  for (const cls of classes) {
    if (isNode3DClass(cls)) has3d = true;
    else if (isCanvasItemClass(cls)) has2d = true;
  }
  const kind: SceneKind = has3d ? "3d" : has2d ? "2d" : "none";
  return { kind, classesSeen: classes.size, ...(truncated ? { truncated: true } : {}) };
}

/** Test seam: forget cached ancestry (after resetApiDocsForTests). */
export function resetSceneKindCacheForTests(): void {
  ancestryCache.clear();
}
