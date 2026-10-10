import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { z } from "zod";

/** Image generation can take over a minute on the larger models; wait this long for the server. */
export const IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/** Shared MCP/CLI image request contract; optional flags preserve omission. */
export const imageGenerationArgsSchema = z.object({
      prompt: z.string().describe("Description of the image to generate"),
      model: z
        .string()
        .optional()
        .describe("Model name or full provider ID. Omit it and the server picks one that reaches the requested size (nano-banana-2 when no size is asked)."),
      style: z
        .string()
        .default("realistic")
        .describe("Style preset: realistic, cartoon, anime, or 'none' to skip"),
      referenceImageUrl: z
        .string()
        .optional()
        .describe("Source image URL for img2img / edit mode. The prompt describes how to transform this image."),
      removeBackground: z.boolean().optional().describe(
        "Remove the background server-side and return an alpha PNG for sprites, icons, or isolated objects."
      ),
      aspectRatio: z
        .enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"])
        .optional()
        .describe("Aspect ratio of the output (default 1:1). The result reports the real width and height."),
      width: z
        .number()
        .int()
        .min(64)
        .max(4096)
        .optional()
        .describe("Smallest output width in pixels; pass with height. 1920 with height 1080 for store key art, 1080 with 1920 for a tall cover."),
      height: z
        .number()
        .int()
        .min(64)
        .max(4096)
        .optional()
        .describe("Smallest output height in pixels; pass with width."),
      options: z
        .record(z.any())
        .optional()
        .describe("Extra model params (seed, negative_prompt, ...). The result lists any it did not use in ignoredOptions."),
      out: z
        .string()
        .optional()
        .describe("Where to save the image on this machine: a folder, or a file path ending in .png, .jpg or .webp. Default: <TMPDIR>/summer-gen/."),
    });

/**
 * Save a generated image where the caller asked (a folder or a file path), or
 * under TMPDIR/summer-gen. Returns the path, or null when the download failed.
 */
export async function saveGeneratedImage(url: string, out?: string, prefix = "img"): Promise<string | null> {
  try {
    const target = out?.trim() ? resolve(out.trim()) : join(tmpdir(), "summer-gen");
    const file = IMAGE_EXTENSIONS.has(extname(target).toLowerCase()) ? target : join(target, `${prefix}-${Date.now()}.png`);
    await mkdir(dirname(file), { recursive: true });
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch {
    return null;
  }
}
