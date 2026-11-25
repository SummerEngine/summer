import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { which } from "./media.js";
import { buildBase, formatConcatList } from "./render.js";

const hasFfmpeg = Boolean(which("ffmpeg") && which("ffprobe"));

describe("formatConcatList", () => {
  it("normalizes Windows backslashes and escapes single quotes for FFmpeg concat", () => {
    expect(formatConcatList(["C:\\Users\\Sam's Game\\seg\\v000.mp4", "/tmp/a'b/v001.mp4"])).toBe(
      "file 'C:/Users/Sam'\\''s Game/seg/v000.mp4'\nfile '/tmp/a'\\''b/v001.mp4'\n",
    );
  });
});

describe.runIf(hasFfmpeg)("content-make render FFmpeg concat list", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "summer-render-concat-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("concatenates rendered shots even when temp/project paths contain backslashes or apostrophes", async () => {
    const dir = join(root, "Sam's Clip");
    mkdirSync(dir, { recursive: true });

    const result = await buildBase([{ color: "black" }], [0, 0.2], dir);

    expect(existsSync(result.base)).toBe(true);
    expect(existsSync(result.bed)).toBe(true);
    const listText = readFileSync(join(dir, "seg", "vlist.txt"), "utf8");
    expect(listText).toContain("Sam'\\''s Clip/seg/v000.mp4");
  });
});
