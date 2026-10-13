/**
 * Asset import into the engine-bound project (Kenney texture pairing + path
 * inference + optional scene placement). ONE copy shared by the MCP asset tools
 * and the CLI dispatch table.
 */
import type { EngineApiClient } from "../api-client.js";
import { ToolInputError } from "../tool-errors.js";
import { safeProjectPath } from "./engine-ops.js";
import { EngineReceiptError, extractOpError, hasPendingOpReceipt, requireCompletedImportReceipt } from "./engine-receipt.js";

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

/** The engine may correct a raster extension after sniffing the bytes. Use the
 *  ordered paths in its completed receipt, and reject malformed supplied paths
 *  instead of reporting or placing a different file. Older receipts omit them. */
function actualImportPath(receipt: unknown, plannedPaths: string[]): string {
  const result = (receipt as { results?: Array<{ meta?: unknown }> })?.results?.[0];
  const meta = result?.meta;
  if (meta === undefined) return plannedPaths.at(-1)!;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new EngineReceiptError("Summer Engine returned invalid import path metadata. Inspect the target before retrying.", receipt);
  }
  const single = plannedPaths.length === 1;
  if ((single && "paths" in meta) || (!single && "path" in meta)) {
    throw new EngineReceiptError("Summer Engine returned invalid import path metadata. Inspect the target before retrying.", receipt);
  }
  const supplied = single ? "path" in meta : "paths" in meta;
  if (!supplied) return plannedPaths.at(-1)!;
  const paths = single
    ? [(meta as { path: unknown }).path]
    : (meta as { paths: unknown }).paths;
  if (!Array.isArray(paths) || paths.length !== plannedPaths.length || paths.some((path, index) => {
    if (typeof path !== "string" || path.length <= "res://".length) return true;
    try { if (safeProjectPath(path) !== path) return true; } catch { return true; }
    const planned = plannedPaths[index]!;
    if (path === planned) return false;
    const dot = planned.lastIndexOf(".");
    const requestedExt = dot > planned.lastIndexOf("/") ? planned.slice(dot + 1).toLowerCase() : "";
    // Engine content-sniffing can change only a raster extension in place.
    return !["png", "jpg", "jpeg", "webp", "bmp"].includes(requestedExt) ||
      !["png", "jpg", "webp", "bmp"].some((ext) => path === `${planned.slice(0, dot + 1)}${ext}`);
  })) {
    throw new EngineReceiptError("Summer Engine returned invalid import path metadata. Inspect the target before retrying.", receipt);
  }
  return paths.at(-1) as string;
}

/** Import a resolved gateway asset into the project (texture + GLB for Kenney
 *  packs) and, for 3D models with a `parent`, instantiate it into `scenePath`
 *  and save. Throws with a user-facing message on any engine refusal. */
export async function importResolvedAsset(client: EngineApiClient, args: ImportResolvedAssetArgs) {
  const { asset, parent, scenePath, path, name } = args;
  if (parent && !scenePath) {
    throw new ToolInputError("scenePath is required when importing an asset into a scene");
  }
  const { imports } = await buildImportEntriesForAsset(asset, path);
  const importResult =
    imports.length === 1
      ? await client.executeOps([
          { op: "ImportFromUrl", url: imports[0]!.url, path: imports[0]!.path },
        ])
      : await client.executeOps([{ op: "ImportFromUrlBatch", imports }]);

  requireCompletedImportReceipt(importResult, imports.length === 1 ? "ImportFromUrl" : "ImportFromUrlBatch", imports.length);
  const actualPath = actualImportPath(importResult, imports.map((entry) => entry.path));

  let addedToScene = false;
  let sceneReceipt: unknown = null;
  if (parent && asset.type === "3d_model") {
    try {
      sceneReceipt = await client.executeIdentityBoundOps([
        {
          op: "InstantiateScene",
          parent,
          scene: actualPath,
          name: sanitizeNodeName(name || asset.title),
        },
        { op: "SaveScene" },
      ], { scenePath });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new EngineReceiptError(
        `Could not confirm asset placement in ${scenePath} after import: ${detail} Inspect the scene before retrying.`,
        { importReceipt: importResult, importedTo: actualPath, scenePath, sceneError: detail }
      );
    }
    const placementFailure = extractOpError(sceneReceipt);
    const placementEnvelope = sceneReceipt && typeof sceneReceipt === "object" && !Array.isArray(sceneReceipt)
      ? sceneReceipt as Record<string, unknown> : null;
    const placementReceipts = (sceneReceipt as { results?: Array<{ ok?: boolean; op?: string; error?: string }> })?.results;
    if (placementFailure || !placementEnvelope || hasPendingOpReceipt(sceneReceipt) ||
        (placementEnvelope.status !== undefined && placementEnvelope.status !== "ok") ||
        (placementEnvelope.terminalState !== undefined && placementEnvelope.terminalState !== "applied" && placementEnvelope.terminalState !== "no_op") ||
        !Array.isArray(placementReceipts) || placementReceipts.length !== 2 ||
        placementReceipts.some((receipt, index) => receipt?.ok !== true ||
          (receipt.op !== undefined && receipt.op !== (index === 0 ? "InstantiateScene" : "SaveScene")))) {
      throw new EngineReceiptError(placementFailure || `Could not confirm asset placement in ${scenePath}. Inspect the scene before retrying.`,
        { importReceipt: importResult, importedTo: actualPath, scenePath, sceneReceipt });
    }
    addedToScene = true;
  }

  return {
    success: true,
    assetId: asset.id,
    asset: asset.title,
    type: asset.type,
    importedTo: actualPath,
    addedToScene,
    parent: parent || null,
    scenePath: scenePath || null,
    importReceipt: importResult,
    sceneReceipt,
  };
}
