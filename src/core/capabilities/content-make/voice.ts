import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { BuildToolError } from "../summer-bundle.js";
import { run, which } from "./media.js";
import type { Word } from "./plan.js";

/**
 * Word times of a voice-over, from a Whisper on this computer: mlx_whisper
 * (Apple silicon) or the openai-whisper command. The words are cut to and
 * captioned from these times.
 */
export async function transcribeWords(audio: string, workDir: string): Promise<Word[]> {
  const out = join(workDir, "whisper");
  mkdirSync(out, { recursive: true });
  const json = join(out, `${basename(audio, extname(audio))}.json`);
  if (!existsSync(json)) {
    if (which("mlx_whisper")) {
      await run("mlx_whisper", [audio, "--model", "mlx-community/whisper-small.en-mlx", "--word-timestamps", "True", "--output-format", "json", "--output-dir", out]);
    } else if (which("whisper")) {
      await run("whisper", [audio, "--model", "small.en", "--word_timestamps", "True", "--output_format", "json", "--output_dir", out]);
    } else {
      throw new BuildToolError(
        "content_tool_missing",
        "A voice-over needs Whisper on this computer for its word times.",
        "Install one (Apple silicon: pipx install mlx-whisper; else pipx install openai-whisper), then run it again.",
        undefined,
        { missing: "Whisper on this computer (pipx install mlx-whisper)" }
      );
    }
  }
  const parsed = JSON.parse(readFileSync(json, "utf8")) as { segments?: Array<{ words?: Array<{ word: string; start: number; end: number }> }> };
  return (parsed.segments ?? []).flatMap((segment) => (segment.words ?? []).map((word) => ({ w: word.word.trim(), s: Math.round(word.start * 100) / 100, e: Math.round(word.end * 100) / 100 }))).filter((word) => word.w);
}
