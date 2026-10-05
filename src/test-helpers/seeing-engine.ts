/**
 * Test double for the seeing tools: an engine whose ScenePreview of a seeing
 * wrapper behaves like the kernel (reads config.json, writes result.json and
 * any requested tile captures), plus native ScenePreview and the bookmark ops.
 * Test-only (imported by *.test.ts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_ROOT } from "../core/package-root.js";
import type { SeeingClient } from "../core/capabilities/seeing/seeing.js";

export const OK_JPEG = readFileSync(join(PACKAGE_ROOT, "src", "core", "capabilities", "__fixtures__", "frames", "02-mcp-scene-render-pausemenu.jpg"));

export interface FakeEngineOptions {
  projectRoot?: string;
  analyze?: (config: Record<string, unknown>) => Record<string, unknown>;
  render?: (config: Record<string, unknown>) => Record<string, unknown>;
  native?: (op: Record<string, unknown>) => Record<string, unknown>;
  bookmarks?: Record<string, { position: string; look_at: string; fov: number; created?: string }>;
  capabilities?: { opKinds: string[] };
  /** Skip writing result.json (a kernel that never ran). */
  silentKernel?: boolean;
}

export interface FakeEngine extends SeeingClient {
  calls: Array<Record<string, unknown>>;
  configs: Array<Record<string, unknown>>;
  wrappers: string[];
  bookmarks: Record<string, { position: string; look_at: string; fov: number; created?: string }>;
}

function defaultRender(config: Record<string, unknown>): Record<string, unknown> {
  const tiles = (config.tiles ?? []) as Array<Record<string, unknown>>;
  const captures: Array<Record<string, unknown>> = [];
  const diffs: Array<Record<string, unknown>> = [];
  tiles.forEach((t, i) => {
    if (typeof t.capture_path === "string") {
      writeFileSync(t.capture_path, OK_JPEG);
      captures.push({ i, path: t.capture_path, size: [1024, 768] });
    }
    if (t.kind === "diff") diffs.push({ i, mean_abs: 0.0123, changed_fraction: 0.042, changed_box: [0.1, 0.2, 0.5, 0.6] });
  });
  return {
    ok: true,
    stage: "render_setup",
    renderer: "gl_compatibility",
    tiles: tiles.map((t, i) => ({ i, kind: t.kind, ...(t.kind === "shot" ? { view: t.view, method: t.view === "normals" ? "material_override" : t.view === "beauty" ? "beauty" : "debug_draw" } : {}) })),
    ...(captures.length ? { captures } : {}),
    ...(diffs.length ? { diffs } : {}),
    warnings: [],
    errors: [],
  };
}

export function fakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const calls: Array<Record<string, unknown>> = [];
  const configs: Array<Record<string, unknown>> = [];
  const wrappers: string[] = [];
  const bookmarks = { ...(options.bookmarks ?? {}) };
  return {
    calls,
    configs,
    wrappers,
    bookmarks,
    getEngineCapabilities: () => (options.capabilities ? { opKinds: options.capabilities.opKinds } : undefined) as never,
    getEngineVersion: () => "0.6.0",
    getSceneState: async () => ({ provenance: { scenePath: "res://main.tscn" } }),
    getProjectRoot: () => options.projectRoot,
    async executeOps(ops: Record<string, unknown>[]) {
      const op = ops[0]!;
      calls.push(op);
      if (op.op === "ScenePreview" && String(op.scene_path).endsWith("/wrapper.tscn")) {
        const dir = dirname(String(op.scene_path));
        wrappers.push(readFileSync(String(op.scene_path), "utf-8"));
        const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as Record<string, unknown>;
        configs.push(config);
        if (!options.silentKernel) {
          const result = config.mode === "analyze" ? (options.analyze?.(config) ?? { ok: true, subjects: [] }) : (options.render ?? defaultRender)(config);
          writeFileSync(join(dir, "result.json"), JSON.stringify(result));
        }
        const size = op.size as [number, number];
        return { results: [{ ok: true, op: "ScenePreview", image_base64: OK_JPEG.toString("base64"), mime: "image/jpeg", width: size[0], height: size[1], framing: "free" }], terminalState: "applied" };
      }
      if (op.op === "ScenePreview") {
        const custom = options.native?.(op);
        if (custom) return { results: [custom] };
        const size = op.size as [number, number];
        return {
          results: [{ ok: true, op: "ScenePreview", image_base64: OK_JPEG.toString("base64"), mime: "image/jpeg", width: size[0], height: size[1], framing: op.framing, environment_used: "scene_world_environment" }],
        };
      }
      if (op.op === "ListCameraBookmarks") {
        return { results: [{ ok: true, op: "ListCameraBookmarks", bookmarks, names: Object.keys(bookmarks).sort() }] };
      }
      if (op.op === "SaveCameraBookmark") {
        const name = String(op.name);
        const overwritten = name in bookmarks;
        bookmarks[name] = { position: String(op.position), look_at: String(op.look_at), fov: Number(op.fov ?? 60), created: new Date().toISOString() };
        return { results: [{ ok: true, op: "SaveCameraBookmark", name, overwritten, pose_source: "explicit" }] };
      }
      return { results: [{ ok: false, error: `unknown op: ${String(op.op)}` }] };
    },
  };
}

export function exists(path: string): boolean {
  return existsSync(path);
}
