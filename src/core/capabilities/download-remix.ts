import { createHash, randomUUID } from "node:crypto";
import { open, link, unlink } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { z } from "zod";
import { BuildToolError } from "./summer-bundle.js";

/** The grant comes from Remix, after Platform checks consent and player access. */
export const downloadRemixInput = {
  gameId: z.string().regex(/^game_[A-Za-z0-9_-]+$/).describe("The game id from the copied Remix prompt."),
  url: z.string().url().describe("The temporary direct PCK URL from Remix, not the game page. Never an account token."),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).describe("The expected SHA-256 from the Remix prompt."),
  size: z.number().int().positive().max(40 * 1024 ** 3).describe("The exact byte size from the Remix prompt."),
  expiresAt: z.string().datetime({ offset: true }).describe("The download expiry from the Remix prompt."),
  output: z.string().min(1).describe("Destination .pck path. Existing files are never overwritten."),
};
export type DownloadRemixInput = z.infer<ReturnType<typeof inputSchema>>;
function inputSchema() { return z.object(downloadRemixInput); }
const failure = (code: string, message: string) => new BuildToolError(code, message, "Click Remix on the game page for a fresh authorized download link, then retry. Games with Remix off cannot issue new links.");

/** Never forwards account credentials, follows redirects, or returns the signed URL. */
export async function downloadRemix(raw: DownloadRemixInput, deps: { fetch?: typeof fetch; now?: () => number } = {}): Promise<Record<string, unknown>> {
  const parsed = inputSchema().safeParse(raw);
  if (!parsed.success) throw failure("invalid_remix_download", "Supply the game id, direct URL, checksum, size and expiry from the copied Remix prompt, plus an output path.");
  const input = parsed.data;
  const url = new URL(input.url);
  const parts = url.pathname.split("/");
  const gameIndex = parts.lastIndexOf("games");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || gameIndex < 1 || parts[gameIndex - 1] !== "v1" || parts[gameIndex + 1] !== input.gameId || parts.at(-1) !== `${input.sha256}.pck`) {
    throw failure("invalid_remix_download", "The link is not a direct PCK for this game and checksum.");
  }
  if (Date.parse(input.expiresAt) <= (deps.now ?? Date.now)()) throw failure("remix_link_expired", "The Remix download link has expired.");
  const output = resolve(input.output);
  if (!output.toLowerCase().endsWith(".pck")) throw failure("invalid_remix_output", "Choose an output path ending in .pck.");
  const temporary = join(dirname(output), `.summer-remix-${randomUUID()}.part`);
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    const response = await (deps.fetch ?? fetch)(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw failure("remix_download_refused", "The PCK download was refused or unavailable.");
    const hash = createHash("sha256");
    let bytes = 0;
    let magic = Buffer.alloc(0);
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > input.size) throw failure("remix_download_invalid", "The download exceeds the expected PCK size.");
      if (magic.length < 4) magic = Buffer.concat([magic, Buffer.from(chunk)]).subarray(0, 4);
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (bytes !== input.size || hash.digest("hex") !== input.sha256 || magic.toString("ascii") !== "GDPC") throw failure("remix_download_invalid", "The downloaded bytes do not match the expected PCK, checksum and size.");
    await file.close(); file = undefined;
    // Publishing by hard link is atomic and refuses an existing destination.
    await link(temporary, output);
    return { ok: true, status: "downloaded", gameId: input.gameId, file: output, sha256: input.sha256, size: bytes, next: "The verified PCK is saved. Inspect it with Summer Engine; an exported pack may need source files before it can be edited." };
  } catch (error) {
    if (error instanceof BuildToolError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw failure("remix_output_exists", "The destination already exists. Choose a new output path.");
    throw failure("remix_download_failed", "Could not save the PCK. Check the destination directory and network, then retry with a fresh link.");
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}
