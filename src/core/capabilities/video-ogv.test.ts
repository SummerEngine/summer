import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloudinaryOgvUrl,
  ffmpegOgvArgs,
  importUrls,
  isConvertibleVideo,
  ogvResPath,
  VideoConvertError,
  type VideoImportClient,
  type VideoOgvDeps,
} from "./video-ogv.js";

const CLIP = "https://res.cloudinary.com/summer/video/upload/v1760000000/summer_art/u_clip_1.mp4";
const OGV = "https://res.cloudinary.com/summer/video/upload/c_limit,h_1080,w_1920/v1760000000/summer_art/u_clip_1.ogv";
const OK = { status: "ok", results: [{ ok: true, op: "ImportFromUrl" }] };

describe("video paths and URLs", () => {
  it("knows a video by the URL's file name or the requested path", () => {
    expect(isConvertibleVideo({ url: "https://x.test/a/clip.MP4?sig=1" })).toBe(true);
    expect(isConvertibleVideo({ url: "https://x.test/media/42/original", path: "res://v/intro.mov" })).toBe(true);
    expect(isConvertibleVideo({ url: "https://x.test/clip.ogv" })).toBe(false);
    expect(isConvertibleVideo({ url: "https://x.test/tree.glb" })).toBe(false);
  });

  it("swaps the extension to .ogv, or infers res://assets/videos/ like the engine", () => {
    expect(ogvResPath({ url: CLIP, path: "res://ui/title_bg.mp4" })).toBe("res://ui/title_bg.ogv");
    expect(ogvResPath({ url: CLIP, path: "res://ui/title_bg" })).toBe("res://ui/title_bg.ogv");
    expect(ogvResPath({ url: "https://x.test/My%20Clip.webm?x=1" })).toBe("res://assets/videos/My_Clip.ogv");
  });

  it("names the Cloudinary .ogv rendition and leaves everything else alone", () => {
    expect(cloudinaryOgvUrl(CLIP)).toBe(OGV);
    expect(cloudinaryOgvUrl(OGV)).toBe(OGV);
    expect(cloudinaryOgvUrl("https://res.cloudinary.com/s/video/upload/v1/song.mp3")).toBeNull();
    expect(cloudinaryOgvUrl("https://res.cloudinary.com/s/video/upload/s--abc--/v1/a.mp4")).toBeNull();
    expect(cloudinaryOgvUrl("https://cdn.example.com/video/upload/v1/a.mp4")).toBeNull();
  });

  it("asks ffmpeg for Theora q8, Vorbis q5 and at most 1920x1080", () => {
    const args = ffmpegOgvArgs("in.mp4", "out.ogv", "libvorbis").join(" ");
    expect(args).toContain("-c:v libtheora -q:v 8");
    expect(args).toContain("-c:a libvorbis -q:a 5");
    expect(args).toContain("min(iw,1920)");
    expect(args).not.toMatch(/-r\b/);
    expect(ffmpegOgvArgs("in.mp4", "out.ogv", null)).toContain("-an");
  });
});

describe("importUrls", () => {
  let root: string;
  let ops: Record<string, unknown>[][];
  let client: VideoImportClient;
  let deps: VideoOgvDeps;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "video-ogv-"));
    ops = [];
    client = {
      getProjectRoot: () => root,
      async executeOps(batch) {
        ops.push(batch);
        const op = batch[0]!;
        if (op.op === "RenameFile") {
          // What the editor does: move the file and register it.
          await rename(join(root, String(op.from).slice(6)), join(root, String(op.to).slice(6)));
          return { status: "ok", results: [{ ok: true, op: "RenameFile" }] };
        }
        return OK;
      },
    };
    deps = {
      ffmpegTheora: vi.fn(async () => ({ audio: "libvorbis" as const })),
      runFfmpeg: vi.fn(async (args: string[]) => writeFile(args[args.length - 1]!, "OggS theora")),
      download: vi.fn(async (_url: string, dir: string) => {
        const file = join(dir, ".summer-download-test.part");
        await writeFile(file, "mp4 bytes");
        return file;
      }),
      convertRemote: vi.fn(async () => "https://res.cloudinary.com/summer/video/upload/c_limit,h_1080,w_1920/v2/summer_art/ogv/x.ogv"),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sends anything that is not a video exactly as before", async () => {
    expect(await importUrls(client, [{ url: "https://x.test/tree.glb" }], { batch: false }, deps)).toBe(OK);
    await importUrls(client, [{ url: "https://x.test/a.png", path: "res://a.png" }], { batch: true }, deps);
    expect(ops).toEqual([
      [{ op: "ImportFromUrl", url: "https://x.test/tree.glb" }],
      [{ op: "ImportFromUrlBatch", imports: [{ url: "https://x.test/a.png", path: "res://a.png" }] }],
    ]);
  });

  it("imports a Summer (Cloudinary) video as its .ogv rendition, with nothing run here", async () => {
    const result = (await importUrls(client, [{ url: CLIP, path: "res://ui/bg.mp4" }], { batch: false }, deps)) as Record<string, unknown>;
    expect(ops).toEqual([[{ op: "ImportFromUrl", url: OGV, path: "res://ui/bg.ogv" }]]);
    expect(result.videoConversions).toEqual([{ from: CLIP, to: "res://ui/bg.ogv", via: "cloudinary" }]);
    expect(result.note).toContain("res://ui/bg.ogv");
    expect(deps.runFfmpeg).not.toHaveBeenCalled();
  });

  it("converts any other video with ffmpeg, writes it into the project and registers it with the editor", async () => {
    const url = "https://cdn.example.com/clips/intro.mp4";
    const result = (await importUrls(
      client,
      [{ url, path: "res://video/intro.mp4" }, { url: "https://x.test/a.png", path: "res://a.png" }],
      { batch: true },
      deps
    )) as Record<string, unknown>;
    expect(await readFile(join(root, "video/intro.ogv"), "utf8")).toBe("OggS theora");
    expect((await readdir(join(root, "video"))).filter((name) => name.startsWith("."))).toEqual([]);
    expect(ops[0]![0]).toMatchObject({ op: "RenameFile", to: "res://video/intro.ogv" });
    expect(ops[1]).toEqual([{ op: "ImportFromUrlBatch", imports: [{ url: "https://x.test/a.png", path: "res://a.png" }] }]);
    expect(result.videoConversions).toEqual([{ from: url, to: "res://video/intro.ogv", via: "ffmpeg" }]);
    expect(result.results).toHaveLength(2);
  });

  it("asks summerengine.com when this ffmpeg has no Theora", async () => {
    deps.ffmpegTheora = vi.fn(async () => null);
    const url = "https://cdn.example.com/clips/intro.webm";
    const result = (await importUrls(client, [{ url }], { batch: false }, deps)) as Record<string, unknown>;
    expect(deps.convertRemote).toHaveBeenCalledWith(url);
    expect(ops).toEqual([[{ op: "ImportFromUrl", url: expect.stringContaining(".ogv"), path: "res://assets/videos/intro.ogv" }]]);
    expect(result.videoConversions).toEqual([{ from: url, to: "res://assets/videos/intro.ogv", via: "summerengine.com" }]);
  });

  it("says how to get going when it cannot convert here and there is no sign-in", async () => {
    deps.ffmpegTheora = vi.fn(async () => null);
    deps.convertRemote = vi.fn(async () => {
      throw new VideoConvertError("not_signed_in");
    });
    await expect(importUrls(client, [{ url: "https://cdn.example.com/a.mov" }], { batch: false }, deps)).rejects.toThrow(
      /summer-engine@latest login/
    );
    expect(ops).toEqual([]);
  });
});
