/**
 * Poly Haven HDRI import (tool/import-hdri). Shared by the MCP tool
 * (summer_import_hdri) and the CLI dispatcher (`summer tool import-hdri`).
 *
 * Talks to Poly Haven's public API — no key, no Summer account, CC0 catalog —
 * then downloads the chosen .hdr/.exr THROUGH the engine's import pipeline
 * (ImportFromUrl) so the result is a usable res:// texture. Every value read
 * from the API is treated as untrusted data: ids must be slugs, download URLs
 * must point back at Poly Haven over https.
 */

import { z } from "zod";

const POLYHAVEN_API_URL = "https://api.polyhaven.com";
const POLYHAVEN_USER_AGENT = "summer-engine-cli";

export const HDRI_RESOLUTIONS = ["1k", "2k", "4k"] as const;
export type HdriResolution = (typeof HDRI_RESOLUTIONS)[number];

/** Refuse downloads above this unless the caller opts in: a 16k .exr is
 *  hundreds of MB pulled through the engine on a user's machine. */
export const HDRI_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/**
 * The one input contract for summer_import_hdri, shared by the MCP tool (pass
 * `.shape` to server.tool) and the CLI dispatcher (`summer tool import-hdri`)
 * so an off-ladder resolution is rejected on both faces.
 */
export const importHdriArgsSchema = z.object({
  query: z.string().optional(),
  assetId: z.string().optional(),
  resolution: z.enum(HDRI_RESOLUTIONS).default("2k"),
  allow_large: z
    .boolean()
    .default(false)
    .describe(`Allow files above ${HDRI_MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB.`),
});

export interface ImportHdriArgs {
  query?: string;
  assetId?: string;
  resolution?: HdriResolution;
  /** Opt in to files above HDRI_MAX_DOWNLOAD_BYTES. */
  allow_large?: boolean;
}

/** The engine surface this capability needs: one ImportFromUrl op. */
export interface HdriImportEngine {
  executeOps(ops: Record<string, unknown>[]): Promise<unknown>;
}

export interface ImportHdriResult {
  success: true;
  assetId: string;
  name?: string;
  resolution: string;
  resolutionNote?: string;
  format: string;
  importedTo: string;
  license: string;
  alternates?: Array<{ id: string; name?: string }>;
  nextStep: string;
  applyScript: string;
}

export type ImportHdriErrorCode =
  | "bad_args"
  | "no_results"
  | "no_hdri_file"
  | "file_too_large"
  | "import_failed"
  | "hdri_import_failed";

export class ImportHdriError extends Error {
  constructor(
    readonly code: ImportHdriErrorCode,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "ImportHdriError";
  }
}

type PolyHavenAssetEntry = {
  name?: string;
  tags?: string[];
  categories?: string[];
};

type PolyHavenFileEntry = { url?: string; size?: number; md5?: string };

type PolyHavenFilesResponse = {
  hdri?: Record<string, Record<string, PolyHavenFileEntry>>;
};

/** Poly Haven asset ids are lowercase slugs. Anything else in an API response
 *  is rejected before it can reach a URL or res:// path. */
export function isSafePolyHavenId(id: string): boolean {
  return /^[a-z0-9_-]{1,100}$/.test(id);
}

/** Only accept download URLs that point back at Poly Haven over https, with
 *  no embedded credentials (https://user:pw@polyhaven.com/... parses to the
 *  right hostname but is not a URL we should ever hand to the engine). */
export function isPolyHavenDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      (parsed.hostname === "polyhaven.com" ||
        parsed.hostname.endsWith(".polyhaven.com") ||
        parsed.hostname === "polyhaven.org" ||
        parsed.hostname.endsWith(".polyhaven.org"))
    );
  } catch {
    return false;
  }
}

async function polyHavenGetJson<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${POLYHAVEN_API_URL}${endpoint}`, {
    headers: { "User-Agent": POLYHAVEN_USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Poly Haven API request failed (${res.status}) for ${endpoint}`);
  }
  return (await res.json()) as T;
}

/** The Poly Haven API has no text-search endpoint; /assets?type=hdris returns
 *  the full HDRI catalog keyed by id. Score entries against the query terms. */
function scorePolyHavenEntry(
  id: string,
  entry: PolyHavenAssetEntry,
  terms: string[]
): number {
  const name = typeof entry.name === "string" ? entry.name.toLowerCase() : "";
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((tag) => typeof tag === "string").map((tag) => tag.toLowerCase())
    : [];
  const categories = Array.isArray(entry.categories)
    ? entry.categories
        .filter((category) => typeof category === "string")
        .map((category) => category.toLowerCase())
    : [];
  let score = 0;
  for (const term of terms) {
    if (id.includes(term)) score += 4;
    if (name.includes(term)) score += 4;
    if (tags.some((tag) => tag === term)) score += 3;
    else if (tags.some((tag) => tag.includes(term))) score += 2;
    if (categories.some((category) => category === term)) score += 3;
    else if (categories.some((category) => category.includes(term))) score += 1;
  }
  return score;
}

function pickHdriFile(
  files: PolyHavenFilesResponse,
  requested: string
): { resolution: string; format: string; url: string; size?: number } | null {
  const hdri = files.hdri;
  if (!hdri || typeof hdri !== "object") return null;
  // Prefer the requested resolution, then step DOWN, then step up.
  const ladder = ["1k", "2k", "4k", "8k", "16k"];
  const start = ladder.indexOf(requested);
  const candidates =
    start === -1
      ? ladder
      : [
          ladder[start]!,
          ...ladder.slice(0, start).reverse(),
          ...ladder.slice(start + 1),
        ];
  for (const resolution of candidates) {
    const byFormat = hdri[resolution];
    if (!byFormat || typeof byFormat !== "object") continue;
    for (const format of ["hdr", "exr"]) {
      const file = byFormat[format];
      if (file && typeof file.url === "string" && isPolyHavenDownloadUrl(file.url)) {
        return { resolution, format, url: file.url, size: file.size };
      }
    }
  }
  return null;
}

/**
 * The summer_run_script body that wires an imported HDRI as the sky. Plain
 * GDScript against WorldEnvironment using only the baseline ctx helpers
 * (get_scene_root / set_owner_recursive / report) — `ctx.ensure_environment`
 * is not part of any shipped engine's ctx API and must not be relied on.
 */
export function hdriApplySnippet(importedPath: string): string {
  return [
    "func run(ctx):",
    "    var root = ctx.get_scene_root()",
    "    var env: WorldEnvironment = null",
    '    var found = root.find_children("*", "WorldEnvironment", true, false)',
    "    if found.size() > 0:",
    "        env = found[0]",
    "    else:",
    "        env = WorldEnvironment.new()",
    '        env.name = "WorldEnvironment"',
    "        root.add_child(env)",
    "        ctx.set_owner_recursive(env)",
    "    var e: Environment = env.environment",
    "    if e == null:",
    "        e = Environment.new()",
    "        env.environment = e",
    "    var mat := PanoramaSkyMaterial.new()",
    `    mat.panorama = load("${importedPath}")`,
    "    var sky := Sky.new()",
    "    sky.sky_material = mat",
    "    e.background_mode = Environment.BG_SKY",
    "    e.sky = sky",
    "    e.ambient_light_source = Environment.AMBIENT_SOURCE_BG",
    "    e.reflected_light_source = Environment.REFLECTION_SOURCE_BG",
    `    ctx.report("sky", "${importedPath}")`,
  ].join("\n");
}

/**
 * Search (or pick by id), choose a file, import through the engine. Throws
 * ImportHdriError with a stable code for every failure the caller should
 * surface as data; unexpected transport errors propagate as plain Errors.
 */
export async function importPolyHavenHdri(
  args: ImportHdriArgs,
  engine: () => Promise<HdriImportEngine>
): Promise<ImportHdriResult> {
  const resolution: HdriResolution = args.resolution ?? "2k";
  const query = args.query?.trim() ?? "";
  if (!args.assetId && !query) {
    throw new ImportHdriError(
      "bad_args",
      "Pass query (to search) or assetId (exact Poly Haven id)."
    );
  }

  let chosenId = args.assetId?.trim() ?? "";
  let chosenName: string | undefined;
  let alternates: { id: string; name?: string }[] = [];

  if (chosenId) {
    if (!isSafePolyHavenId(chosenId)) {
      throw new ImportHdriError(
        "bad_args",
        "assetId must be a Poly Haven slug (lowercase letters, digits, _ or -)."
      );
    }
  } else {
    const catalog = await polyHavenGetJson<Record<string, PolyHavenAssetEntry>>(
      "/assets?type=hdris"
    );
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 1);
    const scored = Object.entries(catalog)
      .filter(([id]) => isSafePolyHavenId(id))
      .map(([id, entry]) => ({
        id,
        entry,
        score: scorePolyHavenEntry(id, entry ?? {}, terms),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) {
      throw new ImportHdriError(
        "no_results",
        `No Poly Haven HDRI matched "${query}". Try broader terms like 'sunset', 'studio', 'night', 'forest'.`
      );
    }
    chosenId = scored[0]!.id;
    chosenName =
      typeof scored[0]!.entry?.name === "string" ? scored[0]!.entry.name : undefined;
    alternates = scored.slice(1, 5).map((candidate) => ({
      id: candidate.id,
      name:
        typeof candidate.entry?.name === "string" ? candidate.entry.name : undefined,
    }));
  }

  const files = await polyHavenGetJson<PolyHavenFilesResponse>(
    `/files/${encodeURIComponent(chosenId)}`
  );
  const file = pickHdriFile(files, resolution);
  if (!file) {
    throw new ImportHdriError(
      "no_hdri_file",
      `Poly Haven asset "${chosenId}" has no downloadable .hdr/.exr — is it an HDRI id?`
    );
  }

  if (
    typeof file.size === "number" &&
    file.size > HDRI_MAX_DOWNLOAD_BYTES &&
    args.allow_large !== true
  ) {
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
    throw new ImportHdriError(
      "file_too_large",
      `Poly Haven "${chosenId}" at ${file.resolution} is ${mb(file.size)} MB, above the ` +
        `${mb(HDRI_MAX_DOWNLOAD_BYTES)} MB ceiling for an engine-side download.`,
      "Pick a lower resolution, or pass allow_large:true to download it anyway."
    );
  }

  const importedPath = `res://sky/${chosenId}_${file.resolution}.${file.format}`;
  const client = await engine();
  const importResult = await client.executeOps([
    { op: "ImportFromUrl", url: file.url, path: importedPath },
  ]);
  const receipts =
    (importResult as { results?: Array<{ ok?: boolean; error?: string }> })?.results ?? [];
  const failure = receipts.find((receipt) => receipt?.ok === false);
  if ((importResult as { status?: string })?.status === "error" || failure) {
    throw new ImportHdriError(
      "import_failed",
      failure?.error || "Could not import the HDRI. Check engine logs.",
      "Make sure Summer Engine is running with the project loaded."
    );
  }

  return {
    success: true,
    assetId: chosenId,
    name: chosenName,
    resolution: file.resolution,
    resolutionNote:
      file.resolution === resolution
        ? undefined
        : `Requested ${resolution} was not available; imported ${file.resolution} instead.`,
    format: file.format,
    importedTo: importedPath,
    license: "CC0 (Poly Haven) — free for any use, no attribution required.",
    alternates: alternates.length > 0 ? alternates : undefined,
    nextStep:
      "Wire it into the environment with summer_run_script using this exact script " +
      "(needs an engine with RunSceneScript; on an older engine run the same body through " +
      "summer_run_editor_script), then verify with summer_screenshot framing:\"camera\" " +
      "(preset framings substitute the environment):",
    applyScript: hdriApplySnippet(importedPath),
  };
}
