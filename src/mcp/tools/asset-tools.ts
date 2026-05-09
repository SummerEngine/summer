import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAuthToken } from "../../lib/auth.js";
import { getClient } from "../server.js";

const GATEWAY_URL =
  process.env.SUMMER_GATEWAY_URL || "https://www.summerengine.com";

/** Kenney Cloudinary URL pattern: .../summer_art/kenney/3d/{pack-slug}/{filename}.glb */
const KENNEY_URL_PATTERN = /\/kenney\/3d\/([^/]+)\//;

function getPackSlugFromUrl(fileUrl: string): string | null {
  return fileUrl.match(KENNEY_URL_PATTERN)?.[1] ?? null;
}

function buildKenneyTextureUrl(fileUrl: string): string {
  const lastSlash = fileUrl.lastIndexOf("/");
  const base = lastSlash >= 0 ? fileUrl.slice(0, lastSlash) : fileUrl;
  return `${base}/Textures/colormap.png`;
}

async function textureExists(url: string): Promise<boolean> {
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
 * See: publicsummerengine/Docs/ASSET_IMPORT_END_TO_END.md
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
        "Not signed in. The user needs to run this in their terminal:\n  npx summer-engine login\nOr open: https://www.summerengine.com/login\nAsset search requires a Summer Engine account (free to create).",
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

  const res = await fetch(`${GATEWAY_URL}/api/mcp/assets?${searchParams}`, {
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
          " The user needs to re-authenticate:\n  npx summer-engine login --force",
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

Requires authentication (so we can attribute usage and apply per-user rate limits): run 'npx summer-engine login' first.`,
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
    "summer_import_asset",
    `Search the asset library and import the best match into the project in one step.

Use when the user wants a specific type of asset added: "Add a tree to the scene", "Import a wooden barrel".
Searches, picks the top result, downloads and imports it, then optionally adds it to the scene.

Requires authentication. If the user gets an auth error, they need to run 'npx summer-engine login' in their terminal first. Summer Engine must be running.`,
    {
      query: z.string().describe("What to find, e.g. 'low-poly tree', 'wooden crate'"),
      parent: z.string().optional().describe("Parent node path to add the asset under, e.g. './World'. If omitted, only imports (no scene placement)"),
      assetType: z.enum(["2d_image", "animation", "3d_model", "audio", "music", "all"]).default("3d_model").describe("Preferred asset type"),
    },
    async ({ query, parent, assetType }) => {
      const searchResult = await searchAssetsApi({ query, assetType, limit: 5 });

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

      const best = assets[0];
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

      const fileName = fileUrl.split("/").pop()?.split("?")[0] || "asset";
      const packSlug = best.packSlug ?? getPackSlugFromUrl(fileUrl) ?? "misc";

      let imports: { url: string; path: string }[];
      if (best.type === "3d_model" && fileUrl.includes("kenney/3d/")) {
        imports = await buildKenneyImportEntries(fileUrl, packSlug, fileName);
      } else {
        const path =
          best.type === "3d_model"
            ? `res://assets/models/${fileName}`
            : `res://assets/${fileName}`;
        imports = [{ url: fileUrl, path }];
      }

      const importPath = imports[imports.length - 1]!.path;

      try {
        const client = await getClient();
        const importResult =
          imports.length === 1
            ? await client.executeOps([{ op: "ImportFromUrl", url: imports[0]!.url, path: imports[0]!.path }])
            : await client.executeOps([{ op: "ImportFromUrlBatch", imports }]);

        const ok = (importResult as { results?: { ok?: boolean }[] })?.results?.[0]?.ok;
        if (!ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "Import failed",
                    message: "Could not import asset. Check engine logs.",
                    asset: best.title,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        if (parent && best.type === "3d_model") {
          await client.executeOps([
            { op: "InstantiateScene", parent, scene: importPath, name: best.title.replace(/\s+/g, "_") },
          ]);
        }
        // 2D sprites and audio: import only; user adds to scene manually

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  asset: best.title,
                  type: best.type,
                  importedTo: importPath,
                  addedToScene: parent ? true : false,
                  parent: parent || null,
                  message: parent
                    ? `Imported "${best.title}" and added to ${parent}`
                    : `Imported "${best.title}" to ${importPath}`,
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
}
