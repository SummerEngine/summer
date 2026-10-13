import { describe, expect, it, vi } from "vitest";
import {
  canOpenReviewUrl,
  defaultCanOpenBrowser,
  generateSfxChoices,
  getChoices,
  getChoicesArgsSchema,
  sfxChoicesArgsSchema,
  type GatewayReply,
  type SfxChoicesDeps,
} from "./sfx-choices.js";

const REVIEW_URL = "https://www.summerengine.com/studio/choices/cs_1";

const choiceSet = {
  choiceSetId: "cs_1",
  reviewUrl: REVIEW_URL,
  studioPath: "/studio/choices/cs_1",
  prompt: "Foley one-shot: two steel swords clash",
  clips: [
    { clipId: "c1", modelId: "eleven_text_to_sound_v2", modelName: "ElevenLabs SFX v2", audioUrl: "https://cdn.example/c1.wav", assetId: "a1", durationSeconds: 1 },
    { clipId: "c2", modelId: "sonilo-sfx-1.1", modelName: "Sonilo SFX 1.1", audioUrl: "https://cdn.example/c2.mp3", assetId: "a2", durationSeconds: 1 },
    { clipId: "c3", modelId: "stable-audio-3-sfx", modelName: "Stable Audio 3 SFX", audioUrl: "https://cdn.example/c3.wav", assetId: "a3", durationSeconds: 1 },
  ],
  failed: [],
};

function fakeDeps(overrides: Partial<SfxChoicesDeps> = {}, reply: GatewayReply = { data: choiceSet, status: 200 }) {
  const deps: SfxChoicesDeps = {
    post: vi.fn(async () => reply),
    get: vi.fn(async () => reply),
    openUrl: vi.fn(async () => undefined),
    canOpenBrowser: () => true,
    ...overrides,
  };
  return deps;
}

describe("generateSfxChoices", () => {
  it("sends the contract body and defaults open to true", async () => {
    const deps = fakeDeps();
    const args = sfxChoicesArgsSchema.parse({ text: "sword clash", durationSeconds: 1, loop: false, models: ["eleven_text_to_sound_v2", "sonilo-sfx-1.1"] });
    expect(args.open).toBe(true);
    await generateSfxChoices(args, deps);
    expect(deps.post).toHaveBeenCalledWith(
      "/api/mcp/generate/audio/choices",
      { capability: "sound_effects", text: "sword clash", durationSeconds: 1, loop: false, models: ["eleven_text_to_sound_v2", "sonilo-sfx-1.1"] },
      expect.any(Number)
    );
  });

  it("leaves out optional fields that were not given (server picks the default three)", async () => {
    const deps = fakeDeps();
    await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "whoosh" }), deps);
    expect((deps.post as any).mock.calls[0][1]).toEqual({ capability: "sound_effects", text: "whoosh" });
  });

  it("rejects unknown models and fewer than two", () => {
    expect(sfxChoicesArgsSchema.safeParse({ text: "x", models: ["mirelo"] }).success).toBe(false);
    expect(sfxChoicesArgsSchema.safeParse({ text: "x", models: ["sonilo-sfx-1.1"] }).success).toBe(false);
    expect(sfxChoicesArgsSchema.safeParse({ text: "" }).success).toBe(false);
  });

  it("reports the Studio tab and opens no browser when the server queued the tab open", async () => {
    const deps = fakeDeps({}, { data: { ...choiceSet, studioTab: { queued: true, tabId: "tab_1" } }, status: 200 });
    const result = await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "clash" }), deps);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, choiceSetId: "cs_1", shown: "studio_tab", reviewUrl: REVIEW_URL });
    expect(result).not.toHaveProperty("notShownBecause");
    expect(result.say).toContain("3 versions");
    expect(result.say).toContain("I opened them in your Summer Studio tab");
    expect(result.next).toContain("summer_get_choices");
    expect((result.clips as unknown[]).length).toBe(3);
  });

  it("falls back to the browser when no Studio tab took it", async () => {
    const deps = fakeDeps({}, { data: { ...choiceSet, studioTab: { queued: false, reason: "no_tab" } }, status: 200 });
    const result = await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "clash" }), deps);
    expect(deps.openUrl).toHaveBeenCalledWith(REVIEW_URL);
    expect(result).toMatchObject({ shown: "browser", notShownBecause: { studioTab: "no_tab" } });
  });

  it("opens the browser for an older server that sends no studioTab", async () => {
    const deps = fakeDeps();
    const result = await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "clash" }), deps);
    expect(deps.openUrl).toHaveBeenCalledWith(REVIEW_URL);
    expect(result).toMatchObject({ shown: "browser" });
    expect(result).not.toHaveProperty("notShownBecause");
  });

  it("reports a queued Studio tab even with open:false (the server already queued it)", async () => {
    const deps = fakeDeps({}, { data: { ...choiceSet, studioTab: { queued: true, tabId: "tab_1" } }, status: 200 });
    const result = await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "clash", open: false }), deps);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(result).toMatchObject({ shown: "studio_tab" });
  });

  it("only returns the URL with open:false, without a browser, or for a non-Summer URL", async () => {
    const off = fakeDeps();
    const r1 = await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "clash", open: false }), off);
    expect(off.openUrl).not.toHaveBeenCalled();
    expect(r1).toMatchObject({ shown: "not_opened", reviewUrl: REVIEW_URL });
    expect(r1.say).toContain(REVIEW_URL);

    const headless = fakeDeps({ canOpenBrowser: () => false });
    const r2 = await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "clash" }), headless);
    expect(headless.openUrl).not.toHaveBeenCalled();
    expect(r2).toMatchObject({ shown: "not_opened", notShownBecause: { browser: "no_browser_here" } });

    const elsewhere = fakeDeps({}, { data: { ...choiceSet, reviewUrl: "https://evil.example/studio/choices/cs_1" }, status: 200 });
    const r3 = await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "clash" }), elsewhere);
    expect(elsewhere.openUrl).not.toHaveBeenCalled();
    expect(r3).toMatchObject({ shown: "not_opened", notShownBecause: { browser: "not_a_summer_url" } });
  });

  it("reports a browser launch failure as not_opened", async () => {
    const deps = fakeDeps({
      openUrl: vi.fn(async () => {
        throw new Error("xdg-open missing");
      }),
    });
    const result = await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "clash" }), deps);
    expect(result).toMatchObject({ ok: true, shown: "not_opened", notShownBecause: { browser: "xdg-open missing" } });
  });

  it("fails cleanly on a gateway error and when no model made a clip", async () => {
    const err = fakeDeps({}, { error: "Insufficient credits.", data: { status: 402 }, status: 402 });
    expect(await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "clash" }), err)).toMatchObject({ ok: false, error: "Insufficient credits." });

    const none = fakeDeps({}, { data: { ...choiceSet, clips: [], failed: [{ modelId: "stable-audio-3-sfx", error: "too short" }] }, status: 200 });
    const result = await generateSfxChoices(sfxChoicesArgsSchema.parse({ text: "clash" }), none);
    expect(result).toMatchObject({ ok: false, failed: [{ modelId: "stable-audio-3-sfx" }] });
    expect(none.openUrl).not.toHaveBeenCalled();
  });
});

describe("getChoices", () => {
  const decided = {
    choiceSetId: "cs_1",
    kind: "sfx",
    prompt: "clash",
    status: "decided",
    preferredModelId: "sonilo-sfx-1.1",
    clips: [
      { ...choiceSet.clips[0], approved: false },
      { ...choiceSet.clips[1], approved: true, note: "less ring" },
      { ...choiceSet.clips[2], approved: true },
    ],
  };

  it("passes waitSeconds and waits longer than the server", async () => {
    const deps = fakeDeps({}, { data: { ...decided, status: "pending" }, status: 200 });
    const result = await getChoices(getChoicesArgsSchema.parse({ choiceSetId: "cs/1", waitSeconds: 50 }), deps);
    const [endpoint, params, timeoutMs] = (deps.get as any).mock.calls[0];
    expect(endpoint).toBe("/api/mcp/choices/cs%2F1");
    expect(params.get("waitSeconds")).toBe("50");
    expect(timeoutMs).toBeGreaterThan(50_000);
    expect(result).toMatchObject({ ok: true, status: "pending" });
    expect(result.next).toContain("again");
  });

  it("caps waitSeconds at 50", () => {
    expect(getChoicesArgsSchema.safeParse({ choiceSetId: "cs_1", waitSeconds: 51 }).success).toBe(false);
  });

  it("lists approved clips with import details and the new default", async () => {
    const deps = fakeDeps({}, { data: decided, status: 200 });
    const result = await getChoices(getChoicesArgsSchema.parse({ choiceSetId: "cs_1" }), deps);
    expect((deps.get as any).mock.calls[0][1].has("waitSeconds")).toBe(false);
    expect(result.approved).toEqual([
      expect.objectContaining({ clipId: "c2", audioUrl: "https://cdn.example/c2.mp3", assetId: "a2", note: "less ring", fileExtension: "mp3" }),
      expect.objectContaining({ clipId: "c3", assetId: "a3", fileExtension: "wav" }),
    ]);
    expect(result.preferredModelId).toBe("sonilo-sfx-1.1");
    expect(result.next).toContain("summer_import_from_url");
    expect(result.next).toContain("sonilo-sfx-1.1");
  });

  it("asks what to change when nothing was approved", async () => {
    const deps = fakeDeps({}, { data: { ...decided, clips: decided.clips.map((clip) => ({ ...clip, approved: false })) }, status: 200 });
    const result = await getChoices(getChoicesArgsSchema.parse({ choiceSetId: "cs_1" }), deps);
    expect(result.approved).toEqual([]);
    expect(result.next).toContain("summer_generate_sfx_choices");
  });
});

describe("page-opening guards", () => {
  it("opens browsers only on summerengine.com or loopback", () => {
    expect(canOpenReviewUrl(REVIEW_URL)).toBe(true);
    expect(canOpenReviewUrl("http://localhost:3000/studio/choices/x")).toBe(true);
    expect(canOpenReviewUrl("https://summerengine.com.evil.example/x")).toBe(false);
    expect(canOpenReviewUrl("not a url")).toBe(false);
  });

  it("treats CI and display-less Linux as headless", () => {
    expect(defaultCanOpenBrowser({ CI: "1" }, "darwin")).toBe(false);
    expect(defaultCanOpenBrowser({}, "linux")).toBe(false);
    expect(defaultCanOpenBrowser({ DISPLAY: ":0" }, "linux")).toBe(true);
    expect(defaultCanOpenBrowser({}, "darwin")).toBe(true);
  });
});
