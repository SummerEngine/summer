import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("./mcp/server.js", () => ({ getClient: vi.fn(), resetClient: vi.fn() }));
vi.mock("./core/telemetry.js", () => ({ recordMcpSession: vi.fn() }));

import * as engineOps from "./core/capabilities/engine-ops.js";
import * as engineReceipt from "./core/capabilities/engine-receipt.js";
import * as sceneTools from "./mcp/tools/scene-tools.js";
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
  "core/capabilities/engine-receipt.ts": ["extractOpError"],
};

/** Both faces, and the owning core module each must import from. */
const FACES: Array<[face: string, owner: string]> = [
  ["core/capabilities/tool-dispatch.ts", "core/capabilities/engine-ops.ts"],
  ["core/capabilities/tool-dispatch.ts", "core/capabilities/asset-import.ts"],
  ["core/capabilities/tool-dispatch.ts", "core/capabilities/engine-receipt.ts"],
  ["mcp/tools/scene-tools.ts", "core/capabilities/engine-ops.ts"],
  ["mcp/tools/file-tools.ts", "core/capabilities/engine-ops.ts"],
  ["mcp/tools/asset-tools.ts", "core/capabilities/asset-import.ts"],
  ["mcp/tools/with-engine.ts", "core/capabilities/engine-receipt.ts"],
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
  });
});
