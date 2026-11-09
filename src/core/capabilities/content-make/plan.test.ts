import { describe, expect, it } from "vitest";
import { onsetTimes } from "./media.js";
import {
  alignScript,
  beatCaptions,
  beatMap,
  bestWindow,
  chunkWords,
  evaluateChecks,
  lineStarts,
  mapTimes,
  musicStart,
  parseCaptionStyle,
  pickReference,
  refHasVoice,
  snapCuts,
  unwrittenLines,
  voiceAnchors,
  wordsOf,
  type PickContext,
} from "./plan.js";
import type { FootageClip, RefBeat, Reference } from "./types.js";

const beat = (t: [number, number], shot: string, vo = "", caption = ""): RefBeat => ({ t, shot, vo, caption });

const clip = (path: string, duration: number, motion: number, tags: string[] = [], kind: "video" | "image" = "video"): FootageClip => ({
  path,
  kind,
  duration,
  width: 1080,
  height: 1920,
  hasAudio: true,
  motion: kind === "image" ? [] : Array.from({ length: Math.ceil(duration * 2) }, () => motion),
  luma: kind === "image" ? [] : Array.from({ length: Math.ceil(duration * 2) }, () => 60),
  tags,
});

const ctx = (over: Partial<PickContext> = {}): PickContext => ({
  usedReferenceIds: new Set(),
  usedFormats: new Set(),
  niches: ["pvp", "fantasy"],
  commits: [],
  voiceReady: false,
  today: "2026-10-17",
  ...over,
});

describe("reference pick", () => {
  const caption = (id: string, formatType: string, extra: Partial<Reference> = {}): Reference => ({
    referenceId: id,
    title: id,
    formatType,
    genres: ["pvp"],
    breakoutRatio: 100,
    stats: { postedAt: "2026-10-01" },
    beats: [beat([0, 2], "hero", "", "a caption")],
    ...extra,
  });

  it("prefers a format the game has not posted and skips used, locked and expired references", () => {
    const refs = [
      caption("used-format", "feature-drop-devlog"),
      caption("fresh-format", "raw-moment-caption"),
      caption("made-already", "tier-list"),
      caption("locked", "hater-twist", { locked: true }),
      caption("expired", "hot-take-vote", { expiresAt: "2026-10-01" }),
    ];
    const pick = pickReference(refs, ctx({ usedFormats: new Set(["feature-drop-devlog"]), usedReferenceIds: new Set(["made-already"]) }));
    expect(pick?.ref.referenceId).toBe("fresh-format");
    expect(pick?.fitReason).toMatch(/^A format this game has not posted yet/);
  });

  it("weighs what changed today and names the commit", () => {
    const refs = [caption("a", "x", { title: "rank every skin" }), caption("b", "y", { title: "boss fight reveal", howGamesCanUseIt: "show the new boss" })];
    const pick = pickReference(refs, ctx({ commits: [{ sha: "3f2a1c9d", title: "Add the frost boss to the arena" }] }));
    expect(pick?.ref.referenceId).toBe("b");
    expect(pick?.fitReason).toBe('You shipped "Add the frost boss to the arena" today (commit 3f2a1c9); a format this game has not posted yet (y); it got 100x its account\'s usual views');
    expect(pick?.commit).toEqual({ sha: "3f2a1c9d", title: "Add the frost boss to the arena" });
  });

  it("ranks a speaking reference down until a voice-over is at hand, and is deterministic on ties", () => {
    const speaking = caption("speaks", "x", { beats: [beat([0, 2], "host", "I made a game", "")] });
    const quiet = caption("quiet", "x");
    expect(pickReference([speaking, quiet], ctx())?.ref.referenceId).toBe("quiet");
    expect(pickReference([speaking, quiet], ctx({ voiceReady: true }))?.ref.referenceId).toBe("quiet");
    expect(pickReference([caption("b", "x"), caption("a", "x")], ctx())?.ref.referenceId).toBe("a");
  });

  it("knows a caption-only reference from a speaking one", () => {
    expect(refHasVoice({ voPattern: "No voice-over. Caption template: ...", beats: [beat([0, 1], "x", "", "c")] })).toBe(false);
    expect(refHasVoice({ voPattern: "Caption only: ...", beats: [beat([0, 1], "x", "words", "c")] })).toBe(false);
    expect(refHasVoice({ voPattern: "'So, uh, this game is actual peak.'", beats: [beat([0, 1], "x", "So, uh", "c")] })).toBe(true);
  });
});

describe("caption look", () => {
  it("reads a held top caption", () => {
    const style = parseCaptionStyle("One caption, two lines, top-centre over the sky: rounded bold sans in lavender with a light outline, sentence case, one emoji at the end. On screen 0.0-6.2 s, then the clip runs clean.", false);
    expect(style).toMatchObject({ mode: "held", y: 0.25, font: "rounded", case: "sentence", color: "#B8A2FF", outline: true });
  });

  it("reads word-by-word captions with a highlight colour", () => {
    const style = parseCaptionStyle("Bold rounded sans-serif in yellow with a thick dark outline, lower case, centred just below the middle, 1 to 3 words at a time in sync with the voice. Key words pop much bigger.", true);
    expect(style).toMatchObject({ mode: "words", chunk: 3, case: "lower", y: 0.6, color: "#FFD60A" });
  });

  it("reads a quoted serif caption held mid-screen", () => {
    const style = parseCaptionStyle("English caption in white serif (book-style) with a thin black outline, lower case, inside quote marks, two lines, centred mid-screen, static for the whole clip.", false);
    expect(style).toMatchObject({ mode: "held", font: "serif", quoted: true, case: "lower", y: 0.45, color: "#FFFFFF" });
  });
});

describe("timing", () => {
  it("maps reference times between anchors", () => {
    expect(mapTimes([0, 1, 2, 3, 4], [0, 2, 4], [0, 3, 4])).toEqual([0, 1.5, 3, 3.5, 4]);
  });

  it("chunks words at punctuation, pauses and the chunk size", () => {
    const words = [
      { w: "So", s: 0, e: 0.2 },
      { w: "this", s: 0.25, e: 0.4 },
      { w: "game", s: 0.45, e: 0.6 },
      { w: "is", s: 0.62, e: 0.7 },
      { w: "peak.", s: 0.75, e: 1 },
      { w: "Really", s: 1.6, e: 1.9 },
    ];
    expect(chunkWords(words, 3).map((chunk) => chunk.map((word) => word.w).join(" "))).toEqual(["So this game", "is peak.", "Really"]);
  });

  it("puts our script on the heard times, even where Whisper heard a word differently", () => {
    const heard = [
      { w: "Pray", s: 0, e: 0.3 },
      { w: "at", s: 0.3, e: 0.4 },
      { w: "the", s: 0.4, e: 0.5 },
      { w: "relic", s: 0.5, e: 0.8 },
      { w: "query", s: 0.8, e: 1.1 },
      { w: "now.", s: 1.2, e: 1.5 },
    ];
    const aligned = alignScript(["Pray", "at", "the", "reliquary", "now."], heard);
    expect(aligned.map((word) => word.w)).toEqual(["Pray", "at", "the", "reliquary", "now."]);
    expect(aligned[4]).toMatchObject({ s: 1.2, e: 1.5 });
    expect(aligned[3].s).toBeGreaterThanOrEqual(0.5);
  });

  it("lands each reference beat on the start of our matching line", () => {
    const lines = ["I made a game", "", "where gods never answer"];
    const words = alignScript(lines.join(" ").split(" "), [
      { w: "I", s: 0, e: 0.1 },
      { w: "made", s: 0.1, e: 0.3 },
      { w: "a", s: 0.3, e: 0.35 },
      { w: "game", s: 0.35, e: 0.7 },
      { w: "where", s: 2, e: 2.2 },
      { w: "gods", s: 2.2, e: 2.5 },
      { w: "never", s: 2.5, e: 2.8 },
      { w: "answer", s: 2.8, e: 3.2 },
    ]);
    const starts = lineStarts(lines, words);
    expect(starts).toEqual([0, null, 2]);
    const beats = [beat([0, 1.5], "a", "x"), beat([1.5, 3], "b"), beat([3, 5], "c", "y")];
    const anchors = voiceAnchors(beats, starts, 6, 3.2);
    expect(anchors.ref).toEqual([0, 3, 6]);
    expect(anchors.ours[1]).toBeCloseTo(1.95);
    expect(anchors.ours[2]).toBeCloseTo(4.2);
  });
});

describe("beat map", () => {
  it("plays a one-take reference as one moving window of the clip that fits", () => {
    const shots = beatMap({
      study: { cuts: [], duration: 10, black: [false] },
      beats: [beat([0, 5], "warrior fights an enemy in the arena"), beat([5, 10], "warrior stands alone")],
      lines: ["", ""],
      clips: [clip("/f/walkup.mp4", 9, 1.5, ["walk"]), clip("/f/duel.mp4", 20, 6, ["duel", "fight", "arena", "enemy"])],
      cuts: [0, 10],
    });
    expect(shots).toHaveLength(1);
    expect(shots[0].src).toBe("/f/duel.mp4");
  });

  it("never shows the same clip twice in a row on fast cuts, and keeps black beats black", () => {
    const cuts = [0, 0.4, 0.8, 1.2, 1.6, 2];
    const shots = beatMap({
      study: { cuts: cuts.slice(1, -1), duration: 2, black: [false, false, true, false, false] },
      beats: [beat([0, 2], "card flips on the beat")],
      lines: [""],
      clips: [clip("/f/a.mp4", 10, 4), clip("/f/b.mp4", 10, 4), clip("/f/c.mp4", 10, 4)],
      cuts,
    });
    expect(shots[2]).toMatchObject({ color: "black" });
    const sources = shots.map((shot) => shot.src);
    for (let i = 1; i < sources.length; i++) if (sources[i] && sources[i - 1]) expect(sources[i]).not.toBe(sources[i - 1]);
  });

  it("takes stills for a beat about cards when there are stills", () => {
    const shots = beatMap({
      study: { cuts: [1], duration: 2, black: [false, false] },
      beats: [beat([0, 2], "illustrated class card page")],
      lines: [""],
      clips: [clip("/f/a.mp4", 10, 4), clip("/f/mask.png", 0, 0, [], "image"), clip("/f/stag.png", 0, 0, [], "image")],
      cuts: [0, 1, 2],
    });
    expect(shots.every((shot) => shot.src?.endsWith(".png"))).toBe(true);
    expect(shots[0].src).not.toBe(shots[1].src);
  });

  it("picks the window with motion and no frozen stretch", () => {
    const frozen: FootageClip = { ...clip("/f/x.mp4", 6, 3), motion: [3, 3, 0.1, 0.1, 0.1, 3, 5, 5, 5, 5, 4, 4] };
    expect(bestWindow(frozen, 2, []).t).toBe(3);
  });
});

describe("captions and words", () => {
  const beats = [beat([0, 1.5], "a", "", "Why did bro"), beat([1.5, 3], "b", "", "Why did bro"), beat([3, 6], "c", "", "")];

  it("holds one line through the beats that repeat the reference's caption", () => {
    expect(beatCaptions(beats, ["Why did bro walk into my combo", "", ""], [0, 6], [0, 6], "held")).toEqual([{ text: "Why did bro walk into my combo", from: 0, to: 3 }]);
  });

  it("flags lines still to write", () => {
    expect(unwrittenLines({ lines: ["TODO: our words for x", "", "done"] })).toEqual([0]);
  });
});

describe("checks", () => {
  const base = {
    shotMotion: [5, 3],
    shotKinds: ["video", "video"] as Array<"video" | "still" | "black">,
    shotSeconds: [2, 3],
    firstSecondMotion: 6,
    firstWords: 0,
    refFirstWords: 0,
    length: 5,
    refLength: 5.2,
    loudness: { lufs: -14.2, truePeak: -1.5 },
    captionBoxes: [[0.2, 0.2, 0.8, 0.3]] as Array<[number, number, number, number]>,
  };

  it("passes a good piece and shows each value with its unit", () => {
    const checks = evaluateChecks(base);
    expect(checks.every((check) => check.pass)).toBe(true);
    expect(checks.map((check) => [check.name, check.value])).toEqual([
      ["hook_time", "0.0 s"],
      ["lowest_motion", "3 YDIF"],
      ["safe_zones", "inside"],
      ["length", "5.0 s"],
      ["gameplay_seconds", "5.0 s"],
      ["loudness", "-14.2 LUFS, -1.5 dBTP"],
    ]);
  });

  it("fails a still shot, a frozen stretch, text outside the safe area and a late hook", () => {
    const checks = evaluateChecks({ ...base, shotMotion: [5, 1], shotFreeze: [1.2, 0], captionBoxes: [[0.2, 0.7, 0.8, 0.85]], firstWords: 1.4 });
    const failed = checks.filter((check) => !check.pass).map((check) => check.name);
    expect(failed).toEqual(["hook_time", "lowest_motion", "safe_zones"]);
    expect(checks.find((check) => check.name === "lowest_motion")?.note).toContain("0, 1");
    expect(checks.find((check) => check.name === "hook_time")?.value).toBe("1.4 s");
  });
});

describe("music", () => {
  it("starts the song where the most cuts land on its beats, then snaps the rest", () => {
    const onsets = Array.from({ length: 40 }, (_, i) => Math.round((3.1 + i * 0.5) * 100) / 100);
    const cuts = [0, 0.5, 1.0, 1.52, 2];
    const fit = musicStart(onsets, cuts, 30);
    expect(fit.hits).toBe(3);
    expect(fit.start).toBe(2.6);
    expect(snapCuts(cuts, onsets, fit.start)).toEqual([0, 0.5, 1, 1.5, 2]);
  });

  it("finds the clicks in a signal", () => {
    const rate = 4000;
    const samples = new Float32Array(rate * 3);
    for (const at of [0.5, 1.25, 2.0]) for (let i = 0; i < 200; i++) samples[Math.round(at * rate) + i] = Math.sin(i) * 0.8;
    const found = onsetTimes(samples, rate);
    expect(found).toHaveLength(3);
    expect(found[0]).toBeCloseTo(0.5, 1);
    expect(found[2]).toBeCloseTo(2.0, 1);
  });
});

describe("words of", () => {
  it("drops filler and short words", () => {
    expect(wordsOf("The Hollow Stag walks up to the camera's lens")).toEqual(["hollow", "stag", "walks", "camera", "lens"]);
  });
});
