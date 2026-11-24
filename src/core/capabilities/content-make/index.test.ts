import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentMakeDeps } from "./index.js";
import type { FootageClip, Plan, Reference, Study } from "./types.js";

const mockRenderState = vi.hoisted(() => ({
  renderCount: 0,
  reportForRender: vi.fn<(renderCall: number) => { shots: number[]; freeze: number[]; firstSecond: number }>(),
  footage: { clips: [] as FootageClip[], music: [] as string[] },
}));

vi.mock("./study.js", async () => {
  const actual = await vi.importActual<typeof import("./study.js")>("./study.js");
  return {
    ...actual,
    indexFootage: vi.fn(async () => mockRenderState.footage),
  };
});

vi.mock("./render.js", async () => {
  const actual = await vi.importActual<typeof import("./render.js")>("./render.js");
  return {
    ...actual,
    fontFile: vi.fn(() => "stub.ttf"),
    buildBase: vi.fn(async (_shots: unknown, cuts: readonly number[], dir: string) => {
      mockRenderState.renderCount += 1;
      mkdirSync(dir, { recursive: true });
      const base = join(dir, "base.mp4");
      const bed = join(dir, "bed.wav");
      writeFileSync(base, "stub-base");
      writeFileSync(bed, "stub-bed");
      return { base, bed, frameCuts: [...cuts] };
    }),
    captionTrack: vi.fn(async (_items: unknown, _end: unknown, _style: unknown, _font: unknown, dir: string) => {
      const track = join(dir, "captions.mov");
      writeFileSync(track, "stub-captions");
      return { track, boxes: [] };
    }),
    mix: vi.fn(async ({ out }: { out: string }) => {
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, `stub-out-${mockRenderState.renderCount}`);
    }),
    motionReport: vi.fn(async () => mockRenderState.reportForRender(mockRenderState.renderCount)),
    cover: vi.fn(async (_video: string, _at: number, out: string) => {
      writeFileSync(out, "stub-cover");
      return out;
    }),
    sideBySide: vi.fn(async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, out: string) => {
      writeFileSync(out, "stub-side-by-side");
      return out;
    }),
    contactSheet: vi.fn(async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, _e: unknown, out: string) => {
      writeFileSync(out, "stub-contact-sheet");
      return out;
    }),
  };
});

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return {
    ...actual,
    requireTools: vi.fn(),
    ffmpeg: vi.fn(async () => ({ stdout: "", stderr: "" })),
    magick: vi.fn(async () => ({ stdout: "", stderr: "" })),
    probe: vi.fn(async () => ({
      width: 1080,
      height: 1920,
      duration: 6.0,
      hasAudio: true,
      fps: 30,
    })),
    loudness: vi.fn(async () => ({ lufs: -14, truePeak: -1.5 })),
  };
});

import { contentMake } from "./index.js";

function makeClip(path: string, perHalfSecondMotion: number[]): FootageClip {
  return {
    path,
    kind: "video",
    duration: perHalfSecondMotion.length * 0.5,
    width: 1080,
    height: 1920,
    hasAudio: false,
    motion: perHalfSecondMotion,
    luma: perHalfSecondMotion.map(() => 60),
    tags: [],
  };
}

function makeDeps(cwd: string): ContentMakeDeps {
  return {
    cloud: vi.fn(async (op: string) => {
      if (op === "content.get_kit") {
        return {
          ok: true,
          result: {
            kit: {
              gameName: "Test Game",
              niches: [],
              hashtags: { core: [] },
              learnings: [],
            },
          },
        };
      }
      if (op === "content.get_reference") {
        return {
          ok: true,
          result: {
            reference: {
              referenceId: "ref-1",
              title: "Test Reference",
              formatType: "raw-moment-caption",
              beats: [{ t: [0, 6], shot: "gameplay", vo: "", caption: "Look at this" }],
            },
          },
        };
      }
      if (op === "content.list_references" || op === "content.list_pieces") {
        return { ok: true, result: { items: [], nextCursor: null } };
      }
      return { ok: true, result: {} };
    }),
    put: vi.fn(async () => undefined),
    progress: vi.fn(),
    now: () => new Date("2026-11-23T08:00:00Z"),
    cwd,
  };
}

function seedWorkDir(workDir: string, cuts: number[], shots: Plan["shots"], footageClips: FootageClip[]) {
  mkdirSync(workDir, { recursive: true });
  const ref: Reference = {
    referenceId: "ref-1",
    title: "Test Reference",
    formatType: "raw-moment-caption",
    beats: [{ t: [0, cuts[cuts.length - 1]], shot: "gameplay", vo: "", caption: "Look at this" }],
  };
  const study: Study = {
    version: 2,
    referenceId: "ref-1",
    file: join(workDir, "ref.mp4"),
    duration: cuts[cuts.length - 1],
    width: 1080,
    height: 1920,
    cuts: cuts.slice(1, -1),
    black: shots.map(() => false),
    hasVoice: false,
    firstCut: cuts[1],
    caption: {
      mode: "held",
      chunk: 3,
      case: "sentence",
      y: 0.45,
      color: "#FFFFFF",
      highlight: null,
      font: "sans",
      size: 84,
      outline: true,
      quoted: false,
    },
    music: false,
  };
  const plan: Plan = {
    version: 1,
    referenceId: "ref-1",
    contentGameId: "cg-1",
    title: "Test Piece",
    format: "raw-moment-caption",
    lines: ["Look at this"],
    refLines: ["Reference line"],
    cuts,
    shots,
    caption: study.caption,
    captions: [{ text: "Look at this", from: 0, to: cuts[cuts.length - 1] }],
    voice: { file: null, needed: false },
    audio: { music: null, bedDb: -14 },
    post: { caption: "Look at this", hashtags: [] },
    why: { referenceId: "ref-1", fitReason: "fit", refStats: {} },
    overlays: [],
  };

  writeFileSync(study.file, "stub-ref");
  writeFileSync(join(workDir, "request.json"), JSON.stringify({ contentGameId: "cg-1", referenceId: "ref-1" }));
  writeFileSync(join(workDir, "reference.json"), JSON.stringify(ref));
  writeFileSync(join(workDir, "study.json"), JSON.stringify(study));
  writeFileSync(join(workDir, "footage.json"), JSON.stringify({ clips: footageClips, music: [] }));
  writeFileSync(join(workDir, "plan.json"), JSON.stringify(plan));
  mockRenderState.footage = { clips: footageClips, music: [] };
  for (const clip of footageClips) {
    if (!existsSync(clip.path)) writeFileSync(clip.path, "stub");
  }
}

describe("contentMake still-shot window deduplication", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "summer-content-make-test-"));
    mockRenderState.renderCount = 0;
    mockRenderState.reportForRender.mockReset();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("uses each shot's original cuts index when avoiding occupied windows on the same clip", async () => {
    const workDir = join(root, "work");
    const clipB = makeClip(join(root, "clipB.mp4"), [5, 5, 5, 5]);
    // clipA is 7.0s (14 half-second buckets):
    // [0.0..1.0): still (motion 0.2) — originally assigned to shot 2
    // [1.0..5.0): high motion 8 — already used by shot 1 (duration 4.0s!)
    // [5.0..7.0): clean motion 5 — free window that shot 2 must pick
    const clipA = makeClip(join(root, "clipA.mp4"), [
      0.2, 0.2,
      8, 8, 8, 8, 8, 8, 8, 8,
      5, 5, 5, 5,
    ]);
    // cuts -> shot durations: shot 0 = 0.5s, shot 1 = 4.0s, shot 2 = 1.5s
    const cuts = [0, 0.5, 4.5, 6.0];
    const shots: Plan["shots"] = [
      { src: clipB.path, t: 0 },
      { src: clipA.path, t: 1.0 },
      { src: clipA.path, t: 0 },
    ];
    seedWorkDir(workDir, cuts, shots, [clipA, clipB]);

    mockRenderState.reportForRender.mockImplementation((call) =>
      call === 1
        ? { shots: [6.0, 6.0, 0.2], freeze: [0, 0, 0.8], firstSecond: 6.0 }
        : { shots: [6.0, 6.0, 6.0], freeze: [0, 0, 0], firstSecond: 6.0 },
    );

    await contentMake(
      { contentGameId: "cg-1", referenceId: "ref-1", referenceFile: join(workDir, "ref.mp4"), footage: [root], workDir, upload: false },
      makeDeps(root),
    );

    const savedPlan = JSON.parse(readFileSync(join(workDir, "plan.json"), "utf8")) as Plan;
    // Shot 2 (1.5s) must NOT jump to [1.5, 3.0] inside shot 1's [1.0, 5.0] window; it must use [5.0, 6.5].
    expect(savedPlan.shots[2]?.t).toBe(5);
  });

  it("uses each alternate shot's own duration from cuts rather than the target shot duration", async () => {
    const workDir = join(root, "work-alt");
    // clipA has zero clean motion windows, forcing fallback to alternate clipB.
    const clipA = makeClip(join(root, "clipA.mp4"), [0.1, 0.1, 0.1, 0.1]);
    // clipB is 5.0s (10 half-second buckets):
    // [0.0..4.0): high motion 8 — already occupied by shot 0 (duration 4.0s!)
    // [4.0..5.0): clean motion 5 — free window that shot 1 (0.5s) must pick
    const clipB = makeClip(join(root, "clipB.mp4"), [
      8, 8, 8, 8, 8, 8, 8, 8,
      5, 5,
    ]);
    // cuts -> shot durations: shot 0 = 4.0s, shot 1 = 0.5s
    const cuts = [0, 4.0, 4.5];
    const shots: Plan["shots"] = [
      { src: clipB.path, t: 0 },
      { src: clipA.path, t: 0 },
    ];
    seedWorkDir(workDir, cuts, shots, [clipA, clipB]);

    mockRenderState.reportForRender.mockImplementation((call) =>
      call === 1
        ? { shots: [6.0, 0.2], freeze: [0, 0.4], firstSecond: 6.0 }
        : { shots: [6.0, 6.0], freeze: [0, 0], firstSecond: 6.0 },
    );

    await contentMake(
      { contentGameId: "cg-1", referenceId: "ref-1", referenceFile: join(workDir, "ref.mp4"), footage: [root], workDir, upload: false },
      makeDeps(root),
    );

    const savedPlan = JSON.parse(readFileSync(join(workDir, "plan.json"), "utf8")) as Plan;
    expect(savedPlan.shots[1]?.src).toBe(clipB.path);
    // Shot 1 (0.5s) must NOT reuse [0.5, 1.0] inside shot 0's [0.0, 4.0] window; it must pick t = 4.0.
    expect(savedPlan.shots[1]?.t).toBe(4);
  });
});
