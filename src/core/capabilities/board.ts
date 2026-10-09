import { z } from "zod";

/**
 * The person's approved planning board (summer_get_board): the look, the
 * characters, the place, the first-minute storyboard and their picks, served by
 * GET /api/cloud-editor/v1/board for the token's own project. With pictures,
 * the look and the picked cards come back as images the model can see.
 */
export const BOARD_ENDPOINT = "/api/cloud-editor/v1/board";

export const boardArgsSchema = z.object({
  project: z
    .string()
    .min(1)
    .max(100)
    .describe("The game's project id (given in your build brief)"),
  pictures: z
    .boolean()
    .optional()
    .describe("Also return the look and the picked cards as images (default true)"),
});

export type BoardArgs = z.infer<typeof boardArgsSchema>;

export function boardQuery({ project, pictures }: BoardArgs): URLSearchParams {
  const params = new URLSearchParams({ project });
  if (pictures !== false) params.set("images", "1");
  return params;
}

type Picture = { label?: unknown; dataUrl?: unknown };
type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** The board as one text block, then each picture as a label and an image block. */
export function boardContent(data: Record<string, unknown>): Content[] {
  const { pictures, ...board } = data;
  const images = (Array.isArray(pictures) ? (pictures as Picture[]) : []).flatMap((picture) => {
    const match =
      typeof picture.dataUrl === "string" ? /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(picture.dataUrl) : null;
    if (!match) return [];
    const label = typeof picture.label === "string" ? picture.label : "Board picture";
    return [
      { type: "text" as const, text: label },
      { type: "image" as const, data: match[2], mimeType: match[1] },
    ];
  });
  const note = images.length
    ? "Compare your latest screenshot against these pictures: palette, shapes and proportions, camera angle, composition. Fix the biggest difference."
    : "No board pictures could be loaded; use the descriptions.";
  return [{ type: "text", text: `${JSON.stringify(board, null, 2)}\n\n${note}` }, ...images];
}
