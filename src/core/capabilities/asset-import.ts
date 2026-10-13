/**
 * Asset import into the engine-bound project (Kenney texture pairing + path
 * inference + optional scene placement). ONE copy shared by the MCP asset tools
 * and the CLI dispatch table.
 */
import type { EngineApiClient } from "../api-client.js";
import { ToolInputError } from "../tool-errors.js";
import { EngineReceiptError, extractOpError, requireCompletedImportReceipt } from "./engine-receipt.js";

/** An asset record as returned by the Summer gateway asset APIs. */
export type GatewayAsset = {
  id: string;
  title: string;
  type: string;
  fileUrl: string;
  thumbnailUrl?: string | null;
  pack?: string | null;
  packSlug?: string | null;
  importUrl?: string;
  downloadUrl?: string;
  fileName?: string | null;
  mimeType?: string | null;
  visibility?: string;
  licenseType?: string | null;
  metadata?: Record<string, unknown>;
};

/** Kenney Cloudinary URL pattern: .../summer_art/kenney/3d/{pack-slug}/{filename}.glb */
const KENNEY_URL_PATTERN = /\/kenney\/3d\/([^/]+)\//;

function getPackSlugFromUrl(fileUrl: string): string | null {
  return fileUrl.match(KENNEY_URL_PATTERN)?.[1] ?? null;
}

export function buildKenneyTextureUrl(fileUrl: string): string {
  const lastSlash = fileUrl.lastIndexOf("/");
  const base = lastSlash >= 0 ? fileUrl.slice(0, lastSlash) : fileUrl;
  return `${base}/Textures/colormap.png`;
}

export async function textureExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Build import entries for Kenney 3D assets: texture first, then GLB.
 * Pack-scoped paths prevent texture collision (each pack has its own Textures/colormap.png).
 */
async function buildKenneyImportEntries(
  fileUrl: string,
  packSlug: string,
  fileName: string
): Promise<{ url: string; path: string }[]> {
  const textureUrl = buildKenneyTextureUrl(fileUrl);
  const hasTexture = await textureExists(textureUrl);
  if (!hasTexture) {
    return [{ url: fileUrl, path: `res://assets/models/kenney/${packSlug}/${fileName}` }];
  }
  const glbPath = `res://assets/models/kenney/${packSlug}/${fileName}`;
  const glbDir = glbPath.replace(/\/[^/]+$/, "");
  const texturePath = `${glbDir}/Textures/colormap.png`;
  return [
    { url: textureUrl, path: texturePath },
    { url: fileUrl, path: glbPath },
  ];
}

function fileNameFromUrl(fileUrl: string): string {
  return fileUrl.split("/").pop()?.split("?")[0] || "asset";
}

/** Godot node names reject . : @ / " %; keep letters, digits and underscores. */
export function sanitizeNodeName(name: string): string {
  return (
    (name || "Asset")
      .replace(/[^\p{L}\p{N}_]+/gu, "_")
      .replace(/^_+|_+$/g, "") || "Asset"
  );
}

async function buildImportEntriesForAsset(
  asset: GatewayAsset,
  targetPath?: string
): Promise<{ imports: { url: string; path: string }[]; importPath: string }> {
  const fileUrl = asset.importUrl || asset.fileUrl;
  if (!fileUrl) throw new Error("Asset has no import URL.");

  const fileName =
    targetPath?.split("/").pop() || asset.fileName || fileNameFromUrl(fileUrl);
  const packSlug = asset.packSlug ?? getPackSlugFromUrl(fileUrl) ?? "misc";

  if (targetPath) {
    if (asset.type === "3d_model" && fileUrl.includes("kenney/3d/")) {
      const textureUrl = buildKenneyTextureUrl(fileUrl);
      const hasTexture = await textureExists(textureUrl);
      if (hasTexture) {
        const glbDir = targetPath.replace(/\/[^/]+$/, "");
        return {
          importPath: targetPath,
          imports: [
            { url: textureUrl, path: `${glbDir}/Textures/colormap.png` },
            { url: fileUrl, path: targetPath },
          ],
        };
      }
    }
    return {
      importPath: targetPath,
      imports: [{ url: fileUrl, path: targetPath }],
    };
  }

  if (asset.type === "3d_model" && fileUrl.includes("kenney/3d/")) {
    const imports = await buildKenneyImportEntries(fileUrl, packSlug, fileName);
    return { imports, importPath: imports[imports.length - 1]!.path };
  }

  const path =
    asset.type === "3d_model"
      ? `res://assets/models/${fileName}`
      : `res://assets/${fileName}`;
  return { imports: [{ url: fileUrl, path }], importPath: path };
}

export interface ImportResolvedAssetArgs {
  asset: GatewayAsset;
  parent?: string;
  scenePath?: string;
  path?: string;
  name?: string;
}

/** Import a resolved gateway asset into the project (texture + GLB for Kenney
 *  packs) and, for 3D models with a `parent`, instantiate it into `scenePath`
 *  and save. Throws with a user-facing message on any engine refusal. */
export async function importResolvedAsset(client: EngineApiClient, args: ImportResolvedAssetArgs) {
  const { asset, parent, scenePath, path, name } = args;
  if (parent && !scenePath) {
    throw new ToolInputError("scenePath is required when importing an asset into a scene");
  }
  const { imports, importPath } = await buildImportEntriesForAsset(asset, path);
  const importResult =
    imports.length === 1
      ? await client.executeOps([
          { op: "ImportFromUrl", url: imports[0]!.url, path: imports[0]!.path },
        ])
      : await client.executeOps([{ op: "ImportFromUrlBatch", imports }]);

  requireCompletedImportReceipt(importResult, imports.length === 1 ? "ImportFromUrl" : "ImportFromUrlBatch", imports.length);

  let addedToScene = false;
  let sceneReceipt: unknown = null;
  if (parent && asset.type === "3d_model") {
    sceneReceipt = await client.executeIdentityBoundOps([
      {
        op: "InstantiateScene",
        parent,
        scene: importPath,
        name: sanitizeNodeName(name || asset.title),
      },
      { op: "SaveScene" },
    ], { scenePath });
    const placementFailure = extractOpError(sceneReceipt);
    const placementEnvelope = sceneReceipt && typeof sceneReceipt === "object" && !Array.isArray(sceneReceipt)
      ? sceneReceipt as Record<string, unknown> : null;
    const placementReceipts = (sceneReceipt as { results?: Array<{ ok?: boolean; error?: string }> })?.results;
    if (placementFailure || !placementEnvelope ||
        (placementEnvelope.status !== undefined && placementEnvelope.status !== "ok") ||
        (placementEnvelope.terminalState !== undefined && placementEnvelope.terminalState !== "applied" && placementEnvelope.terminalState !== "no_op") ||
        !Array.isArray(placementReceipts) || placementReceipts.length !== 2 ||
        placementReceipts.some((receipt) => receipt?.ok !== true)) {
      throw new EngineReceiptError(placementFailure || `Could not confirm asset placement in ${scenePath}. Inspect the scene before retrying.`, sceneReceipt);
    }
    addedToScene = true;
  }

  return {
    success: true,
    assetId: asset.id,
    asset: asset.title,
    type: asset.type,
    importedTo: importPath,
    addedToScene,
    parent: parent || null,
    scenePath: scenePath || null,
    importReceipt: importResult,
    sceneReceipt,
  };
}
