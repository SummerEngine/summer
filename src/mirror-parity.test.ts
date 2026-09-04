import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("./mcp/server.js", () => ({ getClient: vi.fn(), resetClient: vi.fn() }));
vi.mock("./core/telemetry.js", () => ({ recordMcpSession: vi.fn() }));

import * as engineOps from "./core/capabilities/engine-ops.js";
import * as engineReceipt from "./core/capabilities/engine-receipt.js";
import * as capture from "./core/capabilities/capture.js";
import * as engineFallbacks from "./core/capabilities/engine-fallbacks.js";
import * as sceneScript from "./core/capabilities/scene-script.js";
import * as fabricateMesh from "./core/capabilities/fabricate-mesh.js";
import * as cameraView from "./core/capabilities/camera-view.js";
import * as runtimeControl from "./core/capabilities/runtime-control.js";
import * as uiControl from "./core/capabilities/ui-control.js";
import { EVENTS_FALLBACK } from "./core/capability-skew.js";
import * as sceneTools from "./mcp/tools/scene-tools.js";
import * as visualTools from "./mcp/tools/visual-tools.js";
import * as withEngine from "./mcp/tools/with-engine.js";

/**
 * The CLI dispatch table (core/capabilities/tool-dispatch.ts) and the MCP tools
 * (mcp/tools/*) used to carry a mirrored copy of each engine helper, and the
 * copies drifted. There is now ONE definition per helper, in core, and both
 * faces import it. This test pins that: no second definition anywhere under
 * src/, and each face reaches the helper through the owning module.
 */

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)));

const SHARED: Record<string, string[]> = {
  "core/capabilities/engine-ops.ts": [
    "isSingleOnlyOp",
    "sceneMutationOps",
    "chunkOpsForDispatch",
    "executeOpsChunked",
    "executeSceneMutation",
    "safeProjectPath",
    "validSha256",
    "readTextPayload",
    "occurrenceCount",
  ],
  "core/capabilities/asset-import.ts": [
    "buildKenneyTextureUrl",
    "textureExists",
    "sanitizeNodeName",
    "buildImportEntriesForAsset",
    "importResolvedAsset",
  ],
  "core/capabilities/engine-receipt.ts": ["extractOpError", "withOldEngineHint"],
  "core/capabilities/capture.ts": ["captureViewport", "captureScene", "captureGame", "analyzedSnapshot"],
  // summer_play is one function: route choice, quiet-by-default posture,
  // validation, Wave I pre-flight and the result annotations. Neither face may
  // grow its own copy again.
  "core/capabilities/runtime-control.ts": ["playGame", "withPlayPostureEcho", "buildPlayGameOp"],
};

/** Constants both faces must import rather than restate: the engine_lacks_op
 *  fallback sentences (E2E 2026-09-03 F-16). Pinned by name pattern — a
 *  `const *_FALLBACK =` in a face file is a second copy. */
const SHARED_CONSTANT_PATTERNS: Record<string, RegExp> = {
  "core/capabilities/engine-fallbacks.ts": /^(?:export )?const [A-Z_]+_FALLBACK\b/m,
  // The scripting fallbacks live with their op builders.
  "core/capabilities/scene-script.ts": /^(?:export )?const RUN_(?:EDITOR_)?SCRIPT_FALLBACK\b/m,
};
const FALLBACK_FACES = [
  "core/capabilities/tool-dispatch.ts",
  "mcp/tools/spatial-tools.ts",
  "mcp/tools/perception-tools.ts",
  "mcp/tools/script-tools.ts",
];

/** Both faces, and the owning core module each must import from. */
const FACES: Array<[face: string, owner: string]> = [
  ["core/capabilities/tool-dispatch.ts", "core/capabilities/engine-ops.ts"],
  ["core/capabilities/tool-dispatch.ts", "core/capabilities/asset-import.ts"],
  ["core/capabilities/tool-dispatch.ts", "core/capabilities/engine-receipt.ts"],
  ["mcp/tools/scene-tools.ts", "core/capabilities/engine-ops.ts"],
  ["mcp/tools/file-tools.ts", "core/capabilities/engine-ops.ts"],
  ["mcp/tools/asset-tools.ts", "core/capabilities/asset-import.ts"],
  ["mcp/tools/with-engine.ts", "core/capabilities/engine-receipt.ts"],
  ["core/capabilities/tool-dispatch.ts", "core/capabilities/capture.ts"],
  ["mcp/tools/visual-tools.ts", "core/capabilities/capture.ts"],
  ["core/capabilities/tool-dispatch.ts", "core/capabilities/engine-fallbacks.ts"],
  ["mcp/tools/spatial-tools.ts", "core/capabilities/engine-fallbacks.ts"],
  ["mcp/tools/perception-tools.ts", "core/capabilities/engine-fallbacks.ts"],
  ["core/capabilities/tool-dispatch.ts", "core/capabilities/runtime-control.ts"],
  ["mcp/tools/debug-tools.ts", "core/capabilities/runtime-control.ts"],
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function definitionsOf(helper: string): string[] {
  const pattern = new RegExp(`^(?:export )?(?:async )?function ${helper}\\(`, "m");
  return walk(srcRoot)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(srcRoot, file));
}

describe("repo-lint: tool-dispatch <-> mcp/tools share one helper copy", () => {
  it("defines every shared helper exactly once, in its owning core module", () => {
    for (const [owner, helpers] of Object.entries(SHARED)) {
      for (const helper of helpers) {
        expect(definitionsOf(helper), helper).toEqual([owner]);
      }
    }
  });

  it("both faces import the owning module rather than a local copy", () => {
    for (const [face, owner] of FACES) {
      const text = readFileSync(join(srcRoot, face), "utf8");
      const specifier = relative(dirname(join(srcRoot, face)), join(srcRoot, owner))
        .replace(/\\/g, "/")
        .replace(/\.ts$/, ".js");
      const normalized = specifier.startsWith(".") ? specifier : `./${specifier}`;
      expect(text, `${face} -> ${owner}`).toContain(`from "${normalized}"`);
    }
  });

  it("the MCP re-exports are the very same function objects as core", () => {
    expect(sceneTools.executeSceneMutation).toBe(engineOps.executeSceneMutation);
    expect(withEngine.extractOpError).toBe(engineReceipt.extractOpError);
    expect(withEngine.withOldEngineHint).toBe(engineReceipt.withOldEngineHint);
    expect(visualTools.captureViewport).toBe(capture.captureViewport);
    expect(visualTools.captureScene).toBe(capture.captureScene);
  });

  it("defines every engine_lacks_op fallback sentence once, in core, and no face restates one", () => {
    const faceFiles = FALLBACK_FACES.map((face) => join(srcRoot, face));
    for (const [owner, pattern] of Object.entries(SHARED_CONSTANT_PATTERNS)) {
      expect(pattern.test(readFileSync(join(srcRoot, owner), "utf8")), owner).toBe(true);
      for (const face of faceFiles) {
        expect(pattern.test(readFileSync(face, "utf8")), `${relative(srcRoot, face)} restates a fallback owned by ${owner}`).toBe(false);
      }
    }
    // F-16: no fallback may route through an op no shipped engine has.
    for (const [op, sentence] of Object.entries(engineFallbacks.ENGINE_OP_FALLBACKS)) {
      expect(sentence, op).not.toContain("summer_world_snapshot");
      expect(sentence, op).toMatch(/summer_get_scene_tree|summer_inspect_node|summer_set_prop|RunVerification/);
    }
  });

  it("no fallback sentence of any wave routes to a status:preview tool (F-16 — a preview tool is engine_lacks_op on every shipped build)", () => {
    const index = JSON.parse(readFileSync(join(srcRoot, "..", "registry", "generated", "index.json"), "utf8")) as {
      resources: Array<{ kind: string; status?: string; mcp_tool_name?: string }>;
    };
    const previewTools = index.resources
      .filter((r) => r.kind === "tool" && r.status === "preview" && typeof r.mcp_tool_name === "string")
      .map((r) => r.mcp_tool_name as string);
    expect(previewTools.length).toBeGreaterThan(0);
    // Every engine_lacks_op / engine_lacks_events sentence the toolkit can emit, wherever its op builder lives.
    const sentences: Record<string, string> = {
      ...engineFallbacks.ENGINE_OP_FALLBACKS,
      ...runtimeControl.RUNTIME_FALLBACKS,
      PLAY_INSTANCE_FALLBACK: runtimeControl.PLAY_INSTANCE_FALLBACK,
      CAMERA_BOOKMARK_FALLBACK: cameraView.CAMERA_BOOKMARK_FALLBACK,
      FABRICATE_FALLBACK: fabricateMesh.FABRICATE_FALLBACK,
      UI_ACTIONS_FALLBACK: uiControl.UI_ACTIONS_FALLBACK,
      UI_TREE_FALLBACK: uiControl.UI_TREE_FALLBACK,
      UI_ACTIVATE_FALLBACK: uiControl.UI_ACTIVATE_FALLBACK,
      UI_SCREENSHOT_FALLBACK: uiControl.UI_SCREENSHOT_FALLBACK,
      EVENTS_FALLBACK,
      RUN_SCRIPT_FALLBACK: sceneScript.RUN_SCRIPT_FALLBACK,
      RUN_EDITOR_SCRIPT_FALLBACK: sceneScript.RUN_EDITOR_SCRIPT_FALLBACK,
    };
    expect(Object.keys(sentences).length).toBeGreaterThan(30);
    for (const [name, sentence] of Object.entries(sentences)) {
      expect(typeof sentence, name).toBe("string");
      for (const tool of previewTools) {
        expect(sentence, `${name} routes the agent to ${tool}, which is engine_lacks_op on every shipped build`).not.toContain(tool);
      }
    }
  });
});
