import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAuthToken } from "../../core/auth.js";
import { resolveGatewayUrl } from "../../core/config.js";
import { getClient } from "../server.js";
import {
  ImportHdriError,
  importPolyHavenHdri,
  type HdriResolution,
} from "../../core/capabilities/hdri-import.js";
import { importResolvedAsset, type GatewayAsset } from "../../core/capabilities/asset-import.js";

async function searchAssetsApi(params: {
  query: string;
  assetType?: string;
  limit?: number;
  source?: string;
}): Promise<{
  assets?: { id: string; title: string; type: string; fileUrl: string; thumbnailUrl: string | null; pack: string | null; packSlug: string | null; similarity?: number }[];
  count?: number;
  summary?: string;
  message?: string;
  error?: string;
}> {
  const token = await getAuthToken();
  if (!token) {
    return {
      error: "Not logged in",
      message:
        "Not signed in. The user needs to run this in their terminal:\n  npx -y summer-engine@latest login\nOr open: https://www.summerengine.com/login\nAsset search requires a Summer Engine account (free to create).",
    };
  }

  const searchParams = new URLSearchParams();
  searchParams.set("query", params.query);
  if (params.assetType && params.assetType !== "all") {
    searchParams.set("assetType", params.assetType);
  }
  if (params.limit) {
    searchParams.set("limit", String(params.limit));
  }
  if (params.source) {
    searchParams.set("source", params.source);
  }

  const gatewayUrl = await resolveGatewayUrl();
  const res = await fetch(`${gatewayUrl}/api/mcp/assets?${searchParams}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });

  const data = (await res.json()) as {
    assets?: { id: string; title: string; type: string; fileUrl: string; thumbnailUrl: string | null; pack: string | null; packSlug: string | null; similarity?: number }[];
    count?: number;
    summary?: string;
    message?: string;
    error?: string;
  };

  if (!res.ok) {
    if (res.status === 401) {
      return {
        error: "unauthorized",
        message:
          (data.message || "Auth token expired.") +
          " The user needs to re-authenticate:\n  npx -y summer-engine@latest login --force",
      };
    }
    if (res.status === 429) {
      return {
        error: "rate_limited",
        message:
          (data.message || "Asset search rate limit hit. Wait a moment and try again.") +
          " The public library is free, but rate-limited per user to prevent bulk scraping.",
      };
    }
    return {
      error: data.error || "Search failed",
      message: data.message || "Asset search failed",
    };
  }

  return data;
}

type McpAsset = GatewayAsset;

type ApiErrorBody = {
  error?: string;
  message?: string;
};

type AssetDownloadUrlResponse = {
  assetId: string;
  role: "primary" | "thumbnail";
  url: string;
  downloadUrl: string;
  importUrl?: string;
  expiresAt: string | null;
  signed: boolean;
};

async function authedGetJson<T>(
  endpoint: string,
  timeoutMs = 15_000
): Promise<{ data?: T; error?: string; message?: string; status: number }> {
  const token = await getAuthToken();
  if (!token) {
    return {
      status: 401,
      error: "not_logged_in",
      message:
        "Not signed in. Run in your terminal:\n  npx -y summer-engine@latest login",
    };
  }

  const gatewayUrl = await resolveGatewayUrl();
  const res = await fetch(`${gatewayUrl}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json()) as T & ApiErrorBody;
  if (!res.ok) {
    return {
      status: res.status,
      data,
      error: data?.error || "request_failed",
      message: data?.message || "Request failed",
    };
  }
  return { status: res.status, data };
}

async function getAssetApi(assetId: string): Promise<{
  asset?: McpAsset;
  error?: string;
  message?: string;
}> {
  const result = await authedGetJson<{ asset: McpAsset }>(
    `/api/mcp/assets/${encodeURIComponent(assetId)}`
  );
  if (result.error) {
    return { error: result.error, message: result.message };
  }
  return { asset: result.data?.asset };
}

async function getAssetDownloadUrlApi(
  assetId: string,
  role: "primary" | "thumbnail"
): Promise<{ data?: AssetDownloadUrlResponse; error?: string; message?: string }> {
  const result = await authedGetJson<AssetDownloadUrlResponse>(
    `/api/mcp/assets/${encodeURIComponent(assetId)}/download-url?role=${encodeURIComponent(role)}`
  );
  if (result.error) {
    return { error: result.error, message: result.message };
  }
  return { data: result.data };
}

function jsonSuccess(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function jsonError(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    isError: true,
  };
}

export function registerAssetTools(server: McpServer): void {
  server.tool(
    "summer_search_assets",
    `Search for game assets in the Summer Engine ecosystem. **Free for all users** with rate limits.

Sources:
  - "library" (default) — Public asset library (25k+ community assets). Free.
  - "my_assets" — Your own generated/uploaded assets. Free. Query is optional.
  - "all" — Search both library and your assets.

Uses hybrid search: keywords + semantic similarity. Finds assets by name AND by meaning.
Returns asset names, types, preview URLs, and import-ready file URLs.

Cloud tool — works WITHOUT the Summer Engine app open.
Requires authentication (so we can attribute usage and apply per-user rate limits): run 'npx -y summer-engine@latest login' first.`,
    {
      query: z.string().describe("Natural language search, e.g. 'low-poly tree', 'sci-fi weapon'. For my_assets, can be empty to list recent."),
      assetType: z.enum(["2d_image", "animation", "3d_model", "audio", "music", "all"]).default("all").describe("Filter by asset type"),
      limit: z.number().default(10).describe("Max results (1-20)"),
      source: z.enum(["library", "my_assets", "all"]).default("library").describe("Where to search: library (public 25k+), my_assets (your generated assets), all"),
    },
    async ({ query, assetType, limit, source }) => {
      const result = await searchAssetsApi({ query, assetType, limit: Math.min(limit, 20), source });

      if (result.error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: result.error, message: result.message },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                assets: result.assets,
                count: result.count,
                summary: result.summary,
                message: result.message,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "summer_list_my_assets",
    `List or search the signed-in user's generated and uploaded assets.

Use this after generation jobs complete, when the user says "the model I made",
"my last character", or when you need to retrieve an asset before importing it
into the local project.

Returns exact asset IDs plus file/import URLs. Use summer_get_asset for full
metadata or summer_import_asset_by_id to import a specific result.

Cloud tool — works WITHOUT the Summer Engine app open.`,
    {
      query: z
        .string()
        .default("")
        .describe("Optional search term. Empty string lists recent assets."),
      assetType: z
        .enum(["2d_image", "animation", "3d_model", "audio", "music", "all"])
        .default("all")
        .describe("Filter by asset type"),
      limit: z.number().default(10).describe("Max results (1-20)"),
    },
    async ({ query, assetType, limit }) => {
      const result = await searchAssetsApi({
        query,
        assetType,
        limit: Math.min(limit, 20),
        source: "my_assets",
      });
      if (result.error) {
        return jsonError({ error: result.error, message: result.message });
      }
      return jsonSuccess({
        assets: result.assets,
        count: result.count,
        message: result.message,
      });
    }
  );

  server.tool(
    "summer_get_asset",
    `Fetch one asset by exact Summer asset ID.

Use this after a generation job returns assetId/rigAssetId/animationAssetId, or
after summer_list_my_assets/search results when you need the stable file URL,
download URL, viewer URL, metadata, license, visibility, parent chain, or
provider details.

Cloud tool — works WITHOUT the Summer Engine app open.`,
    {
      assetId: z.string().describe("Summer ArtAssets id"),
    },
    async ({ assetId }) => {
      const result = await getAssetApi(assetId);
      if (result.error || !result.asset) {
        return jsonError({
          error: result.error || "asset_not_found",
          message: result.message || "Asset not found.",
        });
      }
      return jsonSuccess({ asset: result.asset });
    }
  );

  server.tool(
    "summer_get_asset_download_url",
    `Get a downloadable URL for a specific asset file.

Today this usually returns the Cloudinary URL plus Summer's download proxy.
The response shape is future-proofed for signed URLs, so prefer this tool over
handing users raw fileUrl when they explicitly ask to download.

Cloud tool — works WITHOUT the Summer Engine app open.`,
    {
      assetId: z.string().describe("Summer ArtAssets id"),
      role: z
        .enum(["primary", "thumbnail"])
        .default("primary")
        .describe("Which file to download"),
    },
    async ({ assetId, role }) => {
      const result = await getAssetDownloadUrlApi(assetId, role);
      if (result.error) {
        return jsonError({ error: result.error, message: result.message });
      }
      return jsonSuccess(result.data);
    }
  );

  server.tool(
    "summer_import_asset_by_id",
    `Import an exact Summer asset ID into the current project.

Use this when the asset was just generated, selected from my assets, or returned
by search. Unlike summer_import_asset, this does not search or guess: it fetches
the asset by ID, downloads it through Summer Engine, and runs Godot's import
pipeline. For 3D models, pass parent and scenePath to instantiate it in that
exact scene; it does not need to be the active editor tab.

Requires the Summer Engine app to be open with the project loaded (generation
itself does not — only this import step does).`,
    {
      assetId: z.string().describe("Summer ArtAssets id"),
      path: z
        .string()
        .optional()
        .describe("Optional target res:// path. If omitted, a path is inferred from asset type and filename."),
      parent: z
        .string()
        .optional()
        .describe("Optional parent node path. For 3D models only; imports and instantiates under this node."),
      scenePath: z
        .string()
        .optional()
        .describe("Required with parent. Exact res:// scene that receives the 3D model."),
      name: z
        .string()
        .optional()
        .describe("Optional scene node name when parent is provided."),
    },
    async ({ assetId, path, parent, scenePath, name }) => {
      const fetched = await getAssetApi(assetId);
      if (fetched.error || !fetched.asset) {
        return jsonError({
          error: fetched.error || "asset_not_found",
          message: fetched.message || "Asset not found.",
        });
      }

      try {
        const imported = await importResolvedAsset(await getClient(), {
          asset: fetched.asset,
          parent,
          scenePath,
          path,
          name,
        });
        return jsonSuccess({
          ...imported,
          message: imported.addedToScene
            ? `Imported "${fetched.asset.title}" and added it to ${parent}.`
            : `Imported "${fetched.asset.title}" to ${imported.importedTo}.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonError({
          error: "import_failed",
          message: msg,
          hint: "Make sure Summer Engine is running and pass the exact scenePath when parent is set.",
        });
      }
    }
  );

  server.tool(
    "summer_import_asset",
    `Search the asset library and import the best match into the project in one step.

Use when the user wants a specific type of asset added: "Add a tree to the scene", "Import a wooden barrel".
Searches, picks the top result, downloads and imports it, then optionally adds it to the scene.

Requires authentication. If the user gets an auth error, they need to run 'npx -y summer-engine@latest login' in their terminal first. Summer Engine must be running.`,
    {
      query: z.string().describe("What to find, e.g. 'low-poly tree', 'wooden crate'"),
      parent: z.string().optional().describe("Parent node path to add the asset under, e.g. './World'. If omitted, only imports (no scene placement)"),
      scenePath: z.string().optional().describe("Required with parent. Exact res:// target scene path."),
      assetType: z.enum(["2d_image", "animation", "3d_model", "audio", "music", "all"]).default("3d_model").describe("Preferred asset type"),
      source: z.enum(["library", "my_assets", "all"]).default("all").describe("Where to search before importing"),
    },
    async ({ query, parent, scenePath, assetType, source }) => {
      const searchResult = await searchAssetsApi({ query, assetType, limit: 5, source });

      if (searchResult.error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: searchResult.error, message: searchResult.message },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const assets = searchResult.assets || [];
      if (assets.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: "No results", message: `No assets found for "${query}". Try different keywords.` },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      const best = assets[0]!;
      const fileUrl = best.fileUrl;
      if (!fileUrl) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { error: "Invalid asset", message: "Asset has no download URL." },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      try {
        const imported = await importResolvedAsset(await getClient(), { asset: best, parent, scenePath });
        // 2D sprites and audio: import only; user adds to scene manually

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  assetId: best.id,
                  asset: best.title,
                  type: best.type,
                  importedTo: imported.importedTo,
                  addedToScene: imported.addedToScene,
                  parent: imported.parent,
                  message: imported.addedToScene
                    ? `Imported "${best.title}" and added to ${parent}`
                    : `Imported "${best.title}" to ${imported.importedTo}`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: "Engine error",
                  message: msg,
                  hint: "Make sure Summer Engine is running.",
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "summer_import_hdri",
    `Search Poly Haven's CC0 HDRI library and import one as environment lighting.

The single cheapest visual-quality upgrade for a 3D scene: a real HDRI sky lights
and reflects the whole world. Searches ~1,000 CC0 HDRIs on Poly Haven's public API
(no account, no key), downloads the .hdr/.exr through the engine's import pipeline
into res://sky/, and returns a ready-to-run summer_run_script snippet that wires it
into the WorldEnvironment (PanoramaSkyMaterial + sky ambient/reflections).

Pass query ("sunset beach", "night city", "studio") to search, or assetId for an
exact Poly Haven id. resolution 2k is right for most games; 4k for hero skies.
All results are CC0 — no attribution required.

Requires the Summer Engine app to be open with the project loaded (the download
runs through the engine). No Summer login needed.`,
    {
      query: z
        .string()
        .optional()
        .describe("What kind of sky/environment, e.g. 'sunset beach', 'overcast field', 'studio'. Omit when assetId is given."),
      assetId: z
        .string()
        .optional()
        .describe("Exact Poly Haven asset id (lowercase slug, e.g. 'kloppenheim_02'). Skips the search."),
      resolution: z
        .enum(["1k", "2k", "4k"])
        .default("2k")
        .describe("HDRI resolution. 2k (default) is right for most games; 4k for hero skies; 1k for quick blockouts."),
    },
    async ({ query, assetId, resolution }) => {
      try {
        const result = await importPolyHavenHdri(
          { query, assetId, resolution: resolution as HdriResolution },
          () => getClient()
        );
        return jsonSuccess(result);
      } catch (err) {
        if (err instanceof ImportHdriError) {
          return jsonError({
            error: err.code,
            message: err.message,
            ...(err.hint ? { hint: err.hint } : {}),
          });
        }
        const msg = err instanceof Error ? err.message : String(err);
        return jsonError({
          error: "hdri_import_failed",
          message: msg,
          hint: "Poly Haven may be unreachable, or Summer Engine is not running.",
        });
      }
    }
  );
}
