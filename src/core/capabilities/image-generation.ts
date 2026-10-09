import { z } from "zod";

/** Shared MCP/CLI image request contract; optional flags preserve omission. */
export const imageGenerationArgsSchema = z.object({
      prompt: z.string().describe("Description of the image to generate"),
      model: z
        .string()
        .default("nano-banana-2")
        .describe("Model name or full provider ID"),
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
    });
