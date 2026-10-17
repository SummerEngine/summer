import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { BuildToolError } from "../summer-bundle.js";
import { loudness, onsets, probe, requireTools, run } from "./media.js";
import { alignScript, beatCaptions, beatMap, bestWindow, chunkWords, evaluateChecks, FREEZE_LIMIT, lineStarts, mapTimes, musicStart, pickReference, snapCuts, unwrittenLines, voiceAnchors, type PickContext } from "./plan.js";
import { buildBase, captionTrack, contactSheet, cover, fontFile, mix, motionReport, pictureTrack, sideBySide, wordCaptionItems, type CaptionBox } from "./render.js";
import { defaultContentRoot, indexFootage, referenceVideo, studyReference } from "./study.js";
import type { Check, FootageClip, FootageIndex, Plan, Reference, Study } from "./types.js";
import { transcribeWords } from "./voice.js";

/**
 * content.make on the person's computer: one finished piece for a game,
 * copied beat for beat from a reference in Summer's library, from the
 * team's own footage, into the team's Review.
 *
 *   pick -> study -> footage -> plan -> voice -> render -> checks -> compare -> upload
 *
 * Every stage leaves its record in the piece's work folder, so a run that
 * stops (missing words, a missing voice-over, a network drop) continues
 * from there with the same workDir. Words are the one thing it never makes
 * up: our lines come from the caller (an agent, or the person), and the
 * reference's own words never reach the piece.
 */

export type Stage = "pick" | "study" | "footage" | "plan" | "voice" | "render" | "checks" | "compare" | "upload";

export interface ContentMakeInput {
  teamId?: string;
  contentGameId?: string;
  referenceId?: string;
  referenceFile?: string;
  note?: string;
  footage?: string[];
  voiceFile?: string;
  lines?: string[];
  title?: string;
  caption?: string;
  hashtags?: string[];
  music?: string;
  font?: string;
  workDir?: string;
  out?: string;
  repo?: string;
  stage?: "plan" | "all";
  upload?: boolean;
  replan?: boolean;
  status?: "draft" | "in_review";
  face?: "cli" | "mcp";
}

/** One operation on Summer's server: its answer envelope. */
export type CloudCall = (op: string, input: Record<string, unknown>) => Promise<{ ok: boolean; status?: string; result?: unknown; error?: { code: string; message: string; details?: unknown } }>;

export interface ContentMakeDeps {
  cloud: CloudCall;
  put: (url: string, file: string, contentType: string) => Promise<void>;
  progress: (stage: Stage, message: string) => void;
  now: () => Date;
  cwd: string;
}

async function defaultCloud(op: string, input: Record<string, unknown>) {
  const { answerOfHosted, callHostedV4, hostedCallFailure } = await import("../../ops/cloud.js");
  try {
    return answerOfHosted(await callHostedV4("summer_call", { op, input })) as Awaited<ReturnType<CloudCall>>;
  } catch (error) {
    return hostedCallFailure(error, { op }) as Awaited<ReturnType<CloudCall>>;
  }
}

/** One PUT of a file to a signed link, retried: uploads of large renders drop now and then. */
async function defaultPut(url: string, file: string, contentType: string): Promise<void> {
  const body = await readFile(file);
  let last = "";
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const response = await fetch(url, { method: "PUT", headers: { "content-type": contentType, "content-length": String(body.length) }, body });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch (error) {
      last = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code ?? error.message : String(error);
    }
    await new Promise((done) => setTimeout(done, 2000 * attempt));
  }
  throw new BuildToolError("content_upload_failed", `Uploading ${basename(file)} failed (${last}).`, "Run it again with the same workDir; finished stages are kept.");
}

export function defaultDeps(face: "cli" | "mcp" = "cli"): ContentMakeDeps {
  return {
    cloud: defaultCloud,
    put: defaultPut,
    progress: face === "cli" ? (stage, message) => process.stderr.write(`[${stage}] ${message}\n`) : () => undefined,
    now: () => new Date(),
    cwd: process.cwd(),
  };
}

const readJson = <T>(file: string): T | null => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  } catch {
    return null;
  }
};
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** The make request this run reports its stages to, when Summer's server keeps them (content.make, claim_make, update_make). */
class MakeRequest {
  private requestId: string | null = null;
  private live = true;
  constructor(private readonly cloud: CloudCall, private readonly teamId: string | undefined) {}

  async open(input: { contentGameId: string; referenceId?: string; note?: string }, existing: string | null): Promise<string | null> {
    if (existing) {
      this.requestId = existing;
      return existing;
    }
    const made = await this.call("content.make", { contentGameId: input.contentGameId, ...(input.referenceId ? { referenceId: input.referenceId } : {}), ...(input.note ? { note: input.note } : {}) });
    const requestId = (made?.requestId as string | undefined) ?? null;
    if (!requestId) return null;
    const claimed = await this.call("content.claim_make", { contentGameId: input.contentGameId, requestId });
    this.requestId = ((claimed?.request as { requestId?: string } | null | undefined)?.requestId ?? requestId) || null;
    return this.requestId;
  }

  async stage(stage: Stage, state: "running" | "done" | "failed", extra: { message?: string; missing?: string; pieceId?: string } = {}): Promise<void> {
    if (!this.requestId) return;
    await this.call("content.update_make", { requestId: this.requestId, stage, state, ...extra });
  }

  private async call(op: string, input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (!this.live) return null;
    const answer = await this.cloud(op, { ...(this.teamId ? { teamId: this.teamId } : {}), ...input });
    if (!answer.ok) {
      // A server without make requests yet: the piece is still made and saved; stages are not reported.
      if (answer.error?.code === "not_found" || answer.error?.code === "unavailable" || /not named|unknown op/i.test(answer.error?.message ?? "")) this.live = false;
      return null;
    }
    return (answer.result ?? {}) as Record<string, unknown>;
  }
}

async function cloudResult<T>(cloud: CloudCall, op: string, input: Record<string, unknown>): Promise<T> {
  const answer = await cloud(op, input);
  if (!answer.ok) {
    const error = answer.error ?? { code: "unavailable", message: `${op} did not answer.` };
    throw new BuildToolError(`content_${error.code}`, `${op}: ${error.message}`, error.code === "not_signed_in" ? "Run: npx -y summer-engine login" : "Fix the input or try again.", undefined, error.details ? { details: error.details } : undefined);
  }
  return answer.result as T;
}

async function allPages<T>(cloud: CloudCall, op: string, input: Record<string, unknown>, max = 4): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < max; page++) {
    const result: { items?: T[]; nextCursor?: string | null } = await cloudResult(cloud, op, { ...input, limit: 50, ...(cursor ? { cursor } : {}) });
    items.push(...(result.items ?? []));
    cursor = result.nextCursor ?? null;
    if (!cursor) break;
  }
  return items;
}

async function recentCommits(repo: string): Promise<string[]> {
  if (!existsSync(join(repo, ".git"))) return [];
  try {
    const { stdout } = await run("git", ["-C", repo, "log", "--since=36 hours ago", "--no-merges", "--pretty=%s", "-n", "40"]);
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

interface Request {
  teamId?: string;
  /** Pieces live in <root>/<game>/<date>-<reference>; the reference videos and footage measurements in <root>/.cache. */
  root: string;
  /** The footage folders, kept so a run with the same workDir needs none. */
  footage: string[];
  contentGameId: string;
  referenceId: string;
  requestId: string | null;
  fitReason: string;
  createdAt: string;
}

export interface ContentMakeResult {
  ok: true;
  status: "saved" | "planned" | "needs_words" | "needs_voice" | "rendered";
  workDir: string;
  referenceId: string;
  next?: string;
  [key: string]: unknown;
}

const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" && value ? [value] : undefined);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** The input from a tool call's arguments (MCP or CLI), unknown fields left out. */
export function contentMakeInput(args: Record<string, unknown>): ContentMakeInput {
  const lines = Array.isArray(args.lines) ? args.lines.map((line) => (typeof line === "string" ? line : "")) : undefined;
  return {
    teamId: text(args.teamId),
    contentGameId: text(args.contentGameId),
    referenceId: text(args.referenceId),
    referenceFile: text(args.referenceFile),
    note: text(args.note),
    footage: strings(args.footage),
    voiceFile: text(args.voiceFile),
    ...(lines ? { lines } : {}),
    title: text(args.title),
    caption: text(args.caption),
    hashtags: strings(args.hashtags),
    music: text(args.music),
    font: text(args.font),
    workDir: text(args.workDir),
    out: text(args.out),
    repo: text(args.repo),
    stage: args.stage === "plan" ? "plan" : "all",
    upload: args.upload !== false,
    replan: args.replan === true,
    ...(args.status === "draft" || args.status === "in_review" ? { status: args.status } : {}),
  };
}

/** Makes one piece; see the header of this file. */
export async function contentMake(input: ContentMakeInput, deps: ContentMakeDeps = defaultDeps(input.face)): Promise<ContentMakeResult> {
  requireTools(["ffmpeg", "ffprobe", "magick"]);
  const today = deps.now().toISOString().slice(0, 10);
  let request = input.workDir ? readJson<Request>(join(resolve(input.workDir), "request.json")) : null;
  if (input.workDir && !request) throw new BuildToolError("content_workdir_invalid", `${input.workDir} is not a content.make work folder (no request.json).`, "Pass the workDir an earlier content.make answered, or leave it out to start a new piece.");
  const teamId = input.teamId ?? request?.teamId;
  const contentGameId = input.contentGameId ?? request?.contentGameId;
  if (!contentGameId) throw new BuildToolError("content_game_required", "Which game? contentGameId is required.", "Get it from content.list_games.");
  const make = new MakeRequest(deps.cloud, teamId);
  const team = teamId ? { teamId } : {};

  // pick
  const kitAnswer = await cloudResult<{ kit: { gameName?: string; niches?: string[]; hashtags?: { core?: string[] }; fonts?: unknown[] } }>(deps.cloud, "content.get_kit", { ...team, contentGameId });
  const kit = kitAnswer.kit;
  const refs = await allPages<Reference>(deps.cloud, "content.list_references", { ...team, contentGameId });
  let ref: Reference | undefined;
  let fitReason = request?.fitReason ?? "";
  const wanted = input.referenceId ?? request?.referenceId;
  if (wanted) {
    ref = refs.find((candidate) => candidate.referenceId === wanted);
    if (!ref) {
      const got = await cloudResult<{ reference?: Reference } & Reference>(deps.cloud, "content.get_reference", { ...team, contentGameId, referenceId: wanted });
      ref = got.reference ?? got;
    }
    if (!fitReason) fitReason = "chosen for this piece";
  } else {
    deps.progress("pick", "Choosing today's reference");
    const pieces = await allPages<{ referenceId?: string; format?: string }>(deps.cloud, "content.list_pieces", { ...team, contentGameId }, 6).catch(() => []);
    const byId = new Map(refs.map((candidate) => [candidate.referenceId, candidate]));
    const usedReferenceIds = new Set(pieces.map((piece) => piece.referenceId).filter((id): id is string => Boolean(id)));
    const usedFormats = new Set(pieces.flatMap((piece) => [piece.format, piece.referenceId ? byId.get(piece.referenceId)?.formatType : undefined]).filter((format): format is string => Boolean(format)));
    const commits = [...(input.note ? [input.note] : []), ...(await recentCommits(resolve(input.repo ?? deps.cwd)))];
    const ctx: PickContext = { usedReferenceIds, usedFormats, niches: kit.niches ?? [], commits, voiceReady: Boolean(input.voiceFile), today };
    const pick = pickReference(refs, ctx);
    if (!pick) {
      await make.stage("pick", "failed", { missing: "a reference this game has not used yet" });
      throw new BuildToolError("content_no_reference", "Every open reference for this game is used, locked or has no beats.", "Pass referenceId, or unlock the full reference library in Studio > Grow > Content.", undefined, { missing: "a reference this game has not used yet" });
    }
    ref = pick.ref;
    fitReason = pick.fitReason;
  }
  if (!ref.beats?.length) throw new BuildToolError("content_reference_unusable", `Reference ${ref.referenceId} has no beats to copy.`, "Pick another reference from content.list_references.");

  const root = request?.root ?? resolve(input.out ?? defaultContentRoot());
  const cacheDir = join(root, ".cache");
  const workDir = input.workDir ? resolve(input.workDir) : join(root, contentGameId, `${today}-${slug(ref.referenceId)}`);
  mkdirSync(workDir, { recursive: true });
  const requestId = await make.open({ contentGameId, referenceId: ref.referenceId, note: input.note }, request?.requestId ?? null);
  const footagePaths = (input.footage?.length ? input.footage.map((path) => resolve(path)) : request?.footage ?? [join(deps.cwd, "content", "footage")]).filter((path) => existsSync(path));
  request = { ...(teamId ? { teamId } : {}), root, footage: footagePaths, contentGameId, referenceId: ref.referenceId, requestId, fitReason, createdAt: request?.createdAt ?? deps.now().toISOString() };
  writeJson(join(workDir, "request.json"), request);
  writeJson(join(workDir, "reference.json"), ref);
  await make.stage("pick", "done", { message: `${ref.title} (${fitReason})` });

  const fail = async (stage: Stage, error: unknown): Promise<never> => {
    const missing = error instanceof BuildToolError ? (error.detail?.missing as string | undefined) : undefined;
    await make.stage(stage, "failed", { message: error instanceof Error ? error.message.slice(0, 300) : String(error), ...(missing ? { missing } : {}) });
    if (error instanceof BuildToolError) throw new BuildToolError(error.code, error.message.replace(` ${error.recovery}`, ""), error.recovery, error.status, { ...error.detail, stage, workDir });
    throw new BuildToolError("content_stage_failed", `content.make stopped at ${stage}: ${error instanceof Error ? error.message : String(error)}`, `Fix it and run again with workDir ${workDir}; finished stages are kept.`, undefined, { stage, workDir });
  };

  // study
  let study = readJson<Study>(join(workDir, "study.json"));
  if (!study || study.referenceId !== ref.referenceId || !existsSync(study.file)) {
    deps.progress("study", `Studying the reference: ${ref.title}`);
    await make.stage("study", "running");
    try {
      study = await studyReference(ref, await referenceVideo(ref, cacheDir, input.referenceFile));
    } catch (error) {
      return fail("study", error);
    }
    writeJson(join(workDir, "study.json"), study);
  }
  await make.stage("study", "done", { message: `${study.cuts.length + 1} shots, ${study.duration} s, ${study.hasVoice ? "voice-over" : "no voice"}` });
  const refBounds = [0, ...study.cuts, study.duration];

  // footage
  deps.progress("footage", `Measuring footage in ${footagePaths.length} folder(s)`);
  await make.stage("footage", "running");
  const footage: FootageIndex = await indexFootage(footagePaths, cacheDir, (done, total) => deps.progress("footage", `${done}/${total} clips`));
  writeJson(join(workDir, "footage.json"), footage);
  if (!footage.clips.length) {
    return fail("footage", new BuildToolError("content_no_footage", "No gameplay footage to cut.", "Pass footage folders with clips of the game (capture mode, screen recordings).", undefined, { missing: "gameplay footage (pass footage folders)" }));
  }
  await make.stage("footage", "done", { message: `${footage.clips.length} clips` });

  // plan: the agent's place to change anything; never overwritten unless replan
  const beats = ref.beats;
  const refLines = beats.map((beat) => (study!.hasVoice ? beat.vo : beat.caption).trim());
  const planFile = join(workDir, "plan.json");
  let plan = input.replan ? null : readJson<Plan>(planFile);
  if (!plan) {
    deps.progress("plan", "Mapping the reference's shots to the footage");
    // a beat that repeats the beat before (a held caption) keeps that line: only the first needs words
    const lines = refLines.map((line, index) => (line && line !== refLines[index - 1] ? `TODO: our words for "${line.replace(/\[[^\]]*\]/g, "…")}"` : ""));
    const music = input.music ?? (study.music && !study.hasVoice ? footage.music[0] ?? null : null);
    plan = {
      version: 1,
      referenceId: ref.referenceId,
      contentGameId,
      title: input.title ?? "",
      format: ref.formatType ?? ref.format ?? "",
      lines,
      refLines,
      cuts: refBounds,
      shots: beatMap({ study, beats, lines, clips: footage.clips, cuts: refBounds }),
      caption: study.caption,
      captions: [],
      voice: { file: input.voiceFile ?? null, needed: study.hasVoice },
      audio: { music, bedDb: study.hasVoice ? -20 : music ? -18 : 0 },
      post: { caption: input.caption ?? "", hashtags: input.hashtags ?? kit.hashtags?.core ?? [], ...(input.title ? { title: input.title } : {}) },
      why: { referenceId: ref.referenceId, fitReason, refStats: { views: ref.stats?.views, likes: ref.stats?.likes, breakoutRatio: ref.breakoutRatio, postedAt: ref.stats?.postedAt } },
      overlays: [],
    };
  }
  if (input.lines) {
    if (input.lines.length !== beats.length) throw new BuildToolError("content_lines_mismatch", `lines has ${input.lines.length} entries; the reference has ${beats.length} beats.`, "Give one line per beat (\"\" for a beat without words); the plan lists them.", undefined, { workDir, beats: beats.map((beat, index) => ({ index, t: beat.t, refWords: refLines[index], shot: beat.shot })) });
    const relink = plan.lines.join("\n") !== input.lines.join("\n");
    plan.lines = input.lines;
    if (relink) plan.shots = beatMap({ study, beats, lines: plan.lines, clips: footage.clips, cuts: plan.cuts });
  }
  if (input.title) plan.title = input.title;
  if (input.caption) plan.post.caption = input.caption;
  if (input.hashtags) plan.post.hashtags = input.hashtags;
  if (input.voiceFile) plan.voice.file = resolve(input.voiceFile);
  if (input.music) plan.audio.music = resolve(input.music);
  if (!plan.title) plan.title = `${kit.gameName ?? contentGameId}: ${plan.lines.find((line) => line && !/^TODO\b/.test(line)) ?? plan.format}`.slice(0, 100);
  writeJson(planFile, plan);
  await make.stage("plan", "done", { message: `${plan.shots.length} shots` });

  const todo = unwrittenLines(plan);
  const beatList = beats.map((beat, index) => ({ index, t: beat.t, shot: beat.shot, refWords: refLines[index], ours: plan!.lines[index] }));
  if (input.stage === "plan" || todo.length) {
    return {
      ok: true,
      status: todo.length ? "needs_words" : "planned",
      workDir,
      referenceId: ref.referenceId,
      reference: { title: ref.title, url: ref.url, formatType: ref.formatType, captionStyle: ref.captionStyle, voPattern: ref.voPattern, howGamesCanUseIt: ref.howGamesCanUseIt, ideas: ref.ideas },
      fitReason,
      plan: planFile,
      beats: beatList,
      next: todo.length
        ? `Write our words for beat(s) ${todo.join(", ")} in the reference's pattern, true to the game, never the reference's own words: call content.make again with workDir and lines (one per beat, "" for none). Shots and framing can be changed in ${planFile}.`
        : `The plan is ready. Change anything in ${planFile}, then call content.make again with workDir.`,
    };
  }

  // voice
  let cuts = plan.cuts;
  let words: Array<{ w: string; s: number; e: number }> = [];
  if (plan.voice.needed) {
    if (!plan.voice.file || !existsSync(plan.voice.file)) {
      const script = join(workDir, "script.txt");
      writeFileSync(script, `${plan.lines.filter(Boolean).join("\n")}\n`);
      await make.stage("voice", "failed", { missing: "the voice-over in the team's voice (script.txt)" });
      return {
        ok: true,
        status: "needs_voice",
        workDir,
        referenceId: ref.referenceId,
        script,
        next: `This reference speaks. Record the lines in ${script} in the team's own voice (one take, the reference's pace) and call content.make again with workDir and voiceFile.`,
      };
    }
    deps.progress("voice", "Timing the voice-over");
    await make.stage("voice", "running");
    try {
      const heard = await transcribeWords(plan.voice.file, workDir);
      const script = plan.lines.flatMap((line) => line.split(/\s+/).filter(Boolean));
      words = alignScript(script, heard);
      const starts = lineStarts(plan.lines, words);
      const end = heard.length ? heard[heard.length - 1].e : study.duration;
      const anchors = voiceAnchors(beats, starts, study.duration, end);
      cuts = mapTimes(refBounds, anchors.ref, anchors.ours);
    } catch (error) {
      return fail("voice", error);
    }
    await make.stage("voice", "done", { message: `${words.length} words` });
  }

  // a song: start it where the most of the reference's cuts land on its beats, then nudge the rest onto beats
  if (!plan.voice.needed && plan.audio.music && existsSync(plan.audio.music)) {
    try {
      const beatsOfSong = await onsets(plan.audio.music);
      const fit = musicStart(beatsOfSong, cuts, (await probe(plan.audio.music)).duration);
      plan.audio.musicStart = fit.start;
      cuts = snapCuts(cuts, beatsOfSong, fit.start);
      deps.progress("render", `Song from ${fit.start} s: ${fit.hits} of ${cuts.length - 2} cuts on its beats`);
    } catch {
      plan.audio.musicStart = 0;
    }
  }

  // render, then swap any shot that does not move for a better window (twice at most)
  deps.progress("render", `Cutting ${plan.shots.length} shots`);
  await make.stage("render", "running");
  const renderDir = join(workDir, "render");
  mkdirSync(renderDir, { recursive: true });
  const end = cuts[cuts.length - 1];
  const clipsByPath = new Map(footage.clips.map((clip) => [clip.path, clip]));
  let stage: Stage = "render";
  let built: Awaited<ReturnType<typeof buildBase>>;
  let motion: Awaited<ReturnType<typeof motionReport>>;
  try {
    for (let round = 0; ; round++) {
      built = await buildBase(plan.shots, cuts, renderDir, (done, total) => deps.progress("render", `shot ${done}/${total}`));
      motion = await motionReport(built.base, built.frameCuts);
      const still = motion.shots.map((value, index) => ((value < 2 || motion.freeze[index] > FREEZE_LIMIT) && plan!.shots[index].src && clipsByPath.get(plan!.shots[index].src!)?.kind === "video" ? index : -1)).filter((index) => index >= 0);
      if (!still.length || round >= 2) break;
      for (const index of still) {
        const shot = plan.shots[index];
        const clip = clipsByPath.get(shot.src!) as FootageClip;
        const seconds = cuts[index + 1] - cuts[index];
        const used = plan.shots.filter((other, j) => j !== index && other.src === clip.path).map((other, j): [number, number] => [other.t ?? 0, (other.t ?? 0) + (cuts[j + 1] - cuts[j])]);
        used.push([shot.t ?? 0, (shot.t ?? 0) + seconds]);
        const better = bestWindow(clip, seconds, used);
        if (better.motion >= 2) shot.t = better.t;
        else {
          // another clip with motion where this one has none
          const alt = footage.clips.filter((other) => other.kind === "video" && other !== clip).map((other) => ({ other, window: bestWindow(other, seconds, []) })).sort((a, b) => b.window.motion - a.window.motion)[0];
          if (alt && alt.window.motion >= 2) {
            shot.src = alt.other.path;
            shot.t = alt.window.t;
          }
        }
      }
      writeJson(planFile, plan);
      deps.progress("render", `Swapped ${still.length} still shot(s) for moving ones`);
    }

    const style = plan.caption;
    const font = fontFile(style.font, input.font);
    const captionItems = plan.captions.length
      ? plan.captions
      : style.mode === "words" && words.length
        ? wordCaptionItems(chunkWords(words, style.chunk), end)
        : beatCaptions(beats, plan.lines, cuts, refBounds, style.mode === "words" ? "beats" : style.mode);
    const captions = await captionTrack(captionItems, end, style, font, renderDir);
    const overlays: string[] = [];
    for (const [index, overlay] of plan.overlays.entries()) overlays.push(await pictureTrack(resolve(workDir, overlay.file), overlay.from, overlay.to, end, join(renderDir, `overlay${index}.mov`)));
    if (captions) overlays.push(captions.track);
    const piece = join(workDir, `${contentGameId}_${slug(ref.referenceId).slice(0, 40)}_9x16.mp4`);
    await mix({ base: built!.base, overlays, voice: plan.voice.needed ? plan.voice.file : null, music: plan.voice.needed ? null : plan.audio.music, musicStart: plan.audio.musicStart, bed: built!.bed, bedDb: plan.audio.bedDb, out: piece, duration: end });
    await make.stage("render", "done");

    // checks
    stage = "checks";
    deps.progress("checks", "Measuring the piece");
    const final = await motionReport(piece, built!.frameCuts);
    const firstCaption = captionItems.length ? captionItems[0].from : null;
    const firstVoice = words.length ? words[0].s : null;
    const firstWords = [firstCaption, firstVoice].filter((value): value is number => value !== null).sort((a, b) => a - b)[0] ?? null;
    const refFirst = beats.find((beat) => beat.caption.trim() || beat.vo.trim());
    const kinds = plan.shots.map((shot) => (!shot.src ? "black" : clipsByPath.get(shot.src)?.kind === "image" ? "still" : "video") as "video" | "still" | "black");
    const boxes: CaptionBox[] = captions?.boxes ?? [];
    const checks: Check[] = evaluateChecks({
      shotMotion: final.shots,
      shotFreeze: final.freeze,
      shotKinds: kinds,
      shotSeconds: cuts.slice(1).map((t, index) => t - cuts[index]),
      firstSecondMotion: final.firstSecond,
      firstWords,
      refFirstWords: refFirst ? refFirst.t[0] : null,
      length: end,
      refLength: study.duration,
      loudness: await loudness(piece),
      captionBoxes: boxes.map((box) => [box.left, box.top, box.right, box.bottom]),
    });
    writeJson(join(workDir, "checks.json"), checks);
    await make.stage("checks", "done", { message: checks.map((check) => `${check.name} ${check.value}${check.pass ? "" : " (fail)"}`).join(", ") });

    // compare
    stage = "compare";
    deps.progress("compare", "Side by side with the reference");
    const sbs = await sideBySide(study.file, refBounds, piece, cuts, renderDir, join(workDir, "side_by_side.mp4"));
    const sheet = await contactSheet(study.file, refBounds, piece, cuts, renderDir, join(workDir, "contact_sheet.jpg"));
    const coverAt = Math.min(end / 2, Math.max(0.4, (cuts[1] ?? 1) / 2));
    const coverFile = await cover(piece, coverAt, join(workDir, "cover.jpg"));
    await make.stage("compare", "done");

    const failing = checks.filter((check) => !check.pass && ["hook_seconds", "min_shot_motion", "safe_zone"].includes(check.name));
    const gameplaySeconds = Number(checks.find((check) => check.name === "gameplay_seconds")?.value ?? 0);
    const summary = { piece, sideBySide: sbs, contactSheet: sheet, cover: coverFile, checks, why: plan.why, title: plan.title };
    if (input.upload === false) return { ok: true, status: "rendered", workDir, referenceId: ref.referenceId, ...summary };

    // upload
    stage = "upload";
    deps.progress("upload", "Uploading to the team's library");
    await make.stage("upload", "running");
    const sha = createHash("sha1").update(readFileSync(piece)).digest("hex");
    const delivered = readJson<{ pieceId: string; sha: string; reviewUrl?: string }>(join(workDir, "delivered.json"));
    if (delivered && delivered.sha === sha) {
      await make.stage("upload", "done", { pieceId: delivered.pieceId });
      return { ok: true, status: "saved", workDir, referenceId: ref.referenceId, pieceId: delivered.pieceId, reviewUrl: delivered.reviewUrl, ...summary };
    }
    const folder = `pieces/${slug(plan.title).slice(0, 50) || ref.referenceId}`;
    const upload = async (file: string, contentType: string, title: string, description: string, tags: string[]): Promise<string> => {
      const begun = await cloudResult<{ uploadId: string; uploadUrl: string; headers: { "content-type": string } }>(deps.cloud, "content.upload_begin", { ...team, fileName: basename(file), contentType, size: statSync(file).size });
      await deps.put(begun.uploadUrl, file, begun.headers["content-type"] ?? contentType);
      const done = await cloudResult<{ item: { itemId: string } }>(deps.cloud, "content.upload_complete", { ...team, uploadId: begun.uploadId, title, description, tags, folder });
      return done.item.itemId;
    };
    const videoItem = await upload(piece, "video/mp4", plan.title, `9:16 render, beat for beat on reference ${ref.referenceId}.`, ["render", plan.format].filter(Boolean));
    const coverItem = await upload(coverFile, "image/jpeg", `${plan.title} (cover)`, "Cover frame.", ["cover"]);
    const sbsItem = await upload(sbs, "video/mp4", `${plan.title} (side by side)`, "The reference and this piece side by side, synced on every beat. For review only; never post it.", ["side-by-side"]);
    const sheetItem = await upload(sheet, "image/jpeg", `${plan.title} (contact sheet)`, "Reference | ours at the middle of every shot.", ["contact-sheet"]);
    const caption = plan.post.caption || plan.title;
    const variants = (["tiktok", "instagram", "youtube"] as const).map((platform) => ({
      platform,
      itemId: videoItem,
      coverItemId: coverItem,
      caption,
      hashtags: plan!.post.hashtags.slice(0, platform === "youtube" ? 3 : 5),
      ...(platform === "youtube" ? { title: (plan!.post.title ?? plan!.title).slice(0, 100) } : {}),
    }));
    const stats = plan.why.refStats;
    const notes = [
      `Why: copies reference ${ref.referenceId} ("${ref.title}") beat for beat${stats.views ? `; ${stats.views.toLocaleString("en-US")} views` : ""}${stats.breakoutRatio ? `, ${Math.round(stats.breakoutRatio)}x its account's usual` : ""}. Fits today: ${plan.why.fitReason}.`,
      `Checks: ${checks.map((check) => `${check.name} ${check.value} ${check.pass ? "pass" : "FAIL"}`).join("; ")}.`,
      `Side by side: library item ${sbsItem}. Contact sheet: ${sheetItem}.`,
    ].join("\n");
    const status = input.status ?? (failing.length ? "draft" : "in_review");
    const extra = { why: plan.why, checks: checks.map(({ name, value, pass }) => ({ name, value, pass })), sideBySideItemId: sbsItem, contactSheetItemId: sheetItem };
    const base = { ...team, title: plan.title, format: plan.format, variants, referenceId: ref.referenceId, gameplaySeconds, notes, status };
    const save = async (op: "content.save_piece" | "content.update_piece", body: Record<string, unknown>) => {
      const withExtra = await deps.cloud(op, { ...body, ...extra });
      // a server that does not take why/checks yet: the same save without them (they are in the notes)
      if (!withExtra.ok && withExtra.error?.code === "invalid_input") return cloudResult<{ piece: { pieceId: string; reviewUrl: string } }>(deps.cloud, op, body);
      if (!withExtra.ok) return cloudResult<{ piece: { pieceId: string; reviewUrl: string } }>(deps.cloud, op, body);
      return withExtra.result as { piece: { pieceId: string; reviewUrl: string } };
    };
    const saved = delivered?.pieceId
      ? await save("content.update_piece", { ...base, pieceId: delivered.pieceId })
      : await save("content.save_piece", { ...base, contentGameId, idempotencyKey: `content-make:${request.requestId ?? workDir}:${sha.slice(0, 12)}` });
    writeJson(join(workDir, "delivered.json"), { pieceId: saved.piece.pieceId, sha, reviewUrl: saved.piece.reviewUrl });
    await make.stage("upload", "done", { pieceId: saved.piece.pieceId });
    return {
      ok: true,
      status: "saved",
      workDir,
      referenceId: ref.referenceId,
      pieceId: saved.piece.pieceId,
      reviewUrl: saved.piece.reviewUrl,
      pieceStatus: status,
      ...summary,
      ...(failing.length ? { next: `Saved as a draft: ${failing.map((check) => check.name).join(", ")} failed. Change the plan and run again with workDir.` } : {}),
    };
  } catch (error) {
    return fail(stage, error);
  }
}

