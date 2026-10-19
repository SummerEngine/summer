/**
 * What `summer preview` shows: the running game's frames, or the editor
 * viewport when no game runs, read through the same local API client every
 * engine tool uses (core/api-client.ts). The server (./server.ts) asks for a
 * frame only while a page is visible and asking, so a closed or hidden tab
 * costs the engine nothing.
 *
 * Capture path, measured on Summer Engine 0.7.2 (2026-10-19, M-series Mac):
 *  - editor viewport, GET /api/snapshot/viewport (1280x671 JPEG, ~47 KB):
 *    p50 45 ms with the editor in front, 100-150 ms with it in the background
 *    (an unfocused editor sleeps ~100 ms per main-loop pass);
 *  - running game, GET /api/snapshot/game (1280x720 JPEG): 1.25-1.35 s, the
 *    same for GameProbe at any max_dim, and requests queue one after another.
 *    The game renders, reads back and PNG-encodes a full-size frame on its
 *    main thread: captured back to back, a game at 117 fps fell to 13 fps;
 *  - IsGameRunning 13 ms; a game snapshot with no game 12 ms (not_running).
 * So the pace comes from the measured capture time, never a fixed rate: one
 * frame every max(200 ms, share x the recent capture time), share 2 for the
 * editor (capture at most half the time; 4-5 fps) and 4 for the game (it
 * keeps running smoothly three quarters of the time; one frame every ~5 s).
 *
 * Status is read on a slower clock: whether a game runs (1 s), the project
 * and scene names (5 s), and a fresh connection attempt while no editor
 * answers (2 s). An editor restart (new token or port) is followed.
 */
import type { EngineSnapshot, SnapshotOptions } from "../api-client.js";
import { missingEngineOpResult, type EngineCapabilities } from "../capability-skew.js";
import { engineNotRunningFromConnectError } from "../error-codes.js";
import { resolveCurrentScene, resolveProjectName } from "../capabilities/project-context.js";
import { extractOpError } from "../capabilities/engine-receipt.js";
import { buildGameInputOp, type InputEvent } from "../capabilities/runtime-control.js";
import { asRecord, numberFrom, stringFrom } from "../util/json.js";
import { engineInputEvent, type PreviewInput } from "./input.js";

/** The engine calls the preview makes: a structural subset of EngineApiClient. */
export interface PreviewEngine {
  viewportSnapshot(options?: SnapshotOptions): Promise<EngineSnapshot>;
  gameSnapshot(options?: SnapshotOptions): Promise<EngineSnapshot>;
  executeOps(ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  getProjectState(): Promise<unknown>;
  getSceneState(): Promise<unknown>;
  credentialsChanged(): Promise<boolean>;
  getEngineCapabilities?(): EngineCapabilities | undefined;
  getEngineVersion?(): string | undefined;
}

/** Fastest pace: 5 frames a second. */
export const MIN_FRAME_INTERVAL_MS = 200;
/** Slowest pace while a frame still comes back. */
export const MAX_FRAME_INTERVAL_MS = 6000;
/** Capture may take at most 1/share of the time: the editor's viewport
 *  read is light; a game frame stalls the game while it is read. */
export const LATENCY_SHARE: Readonly<Record<"game" | "editor", number>> = { editor: 2, game: 4 };
/** Pace of the page while no editor answers. */
export const NO_EDITOR_INTERVAL_MS = 2000;
export const PLAY_CHECK_MS = 1000;
export const META_CHECK_MS = 5000;
export const RECONNECT_MS = 2000;
export const LINK_CHECK_MS = 2000;
/** After a running game's frame failed for a reason other than "not running",
 *  show the editor and try the game again after this long. */
export const GAME_RETRY_MS = 10_000;
/** A request that comes sooner than this share of the pace after the last
 *  capture started gets that capture's frame again: two tabs, or the page and
 *  an agent's own request, never double the engine's work. */
export const SHARE_FRAME_FRACTION = 0.75;

export const NO_EDITOR_MESSAGE = "Editor not running: run npx -y summer-engine@latest dev";
export const GAME_NOT_RUNNING_MESSAGE = "Game not running: showing the editor";

export type PreviewState = "connecting" | "no_editor" | "editor" | "game";

export interface PreviewFrame {
  seq: number;
  source: "game" | "editor";
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  /** The game window's size when the engine scaled the frame down. */
  sourceWidth?: number;
  sourceHeight?: number;
  capturedAt: number;
  latencyMs: number;
}

export interface PreviewStatus {
  service: "summer-preview";
  state: PreviewState;
  /** The one status line the page shows. */
  message: string;
  project: string | null;
  scene: string | null;
  engineVersion: string | null;
  frame: {
    seq: number;
    source: "game" | "editor";
    width: number;
    height: number;
    capturedAt: number;
    latencyMs: number;
  } | null;
  /** Average capture time of the source being shown, ms. */
  latencyMs: number | null;
  /** How long the page waits between frames (from the measured latency). */
  intervalMs: number;
  /** Clicks and keys on the frame reach the running game. */
  input: boolean;
}

export type InputResult = { ok: true; sent: number } | { ok: false; error: string };

export interface PreviewSourceOptions {
  connect: () => Promise<PreviewEngine>;
  now?: () => number;
}

const EWMA_WEIGHT = 0.3;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstResult(value: unknown): Record<string, unknown> | null {
  const results = asRecord(value)?.results;
  return Array.isArray(results) ? asRecord(results[0]) : null;
}

/** The pace for a `source` capture that takes `latencyMs`. */
export function frameIntervalMs(latencyMs: number | null, source: "game" | "editor" = "editor"): number {
  if (latencyMs === null) return MIN_FRAME_INTERVAL_MS;
  const paced = Math.round(latencyMs * LATENCY_SHARE[source]);
  return Math.min(MAX_FRAME_INTERVAL_MS, Math.max(MIN_FRAME_INTERVAL_MS, paced));
}

export class PreviewSource {
  private readonly connectEngine: () => Promise<PreviewEngine>;
  private readonly now: () => number;
  private client: PreviewEngine | null = null;
  private attempted = false;
  private lastConnectAt = -Infinity;
  private lastLinkCheckAt = -Infinity;
  private linkError: string | null = null;
  private playing = false;
  private playingScene: string | null = null;
  private lastPlayCheckAt = -Infinity;
  private project: string | null = null;
  private scene: string | null = null;
  private lastMetaAt = -Infinity;
  private gameBlockedUntil = -Infinity;
  private gameNote: string | null = null;
  private inputSupported = false;
  private latency: Record<"game" | "editor", number | null> = { game: null, editor: null };
  private current: PreviewFrame | null = null;
  private seq = 0;
  private inflight: Promise<PreviewFrame | null> | null = null;
  private lastCaptureAt = -Infinity;
  private inputChain: Promise<unknown> = Promise.resolve();
  private inputQueue: Record<string, unknown>[] = [];

  constructor(options: PreviewSourceOptions) {
    this.connectEngine = options.connect;
    this.now = options.now ?? (() => Date.now());
  }

  /** The current state, without asking the engine anything. */
  status(): PreviewStatus {
    const state = this.state();
    const frame = state === "no_editor" ? null : this.current;
    const latency = frame ? this.latency[frame.source] : null;
    return {
      service: "summer-preview",
      state,
      message: this.message(state),
      project: this.project,
      scene: state === "game" ? this.playingScene ?? this.scene : this.scene,
      engineVersion: this.client?.getEngineVersion?.() ?? null,
      frame: frame
        ? {
            seq: frame.seq,
            source: frame.source,
            width: frame.width,
            height: frame.height,
            capturedAt: frame.capturedAt,
            latencyMs: frame.latencyMs,
          }
        : null,
      latencyMs: latency === null ? null : Math.round(latency),
      intervalMs:
        state === "no_editor" || state === "connecting" ? NO_EDITOR_INTERVAL_MS : frameIntervalMs(latency, frame?.source),
      input: state === "game" && this.inputSupported,
    };
  }

  /** The newest frame: captured now, or the last one when another viewer
   *  asked moments ago. Null while no editor answers. One capture at a time. */
  async frame(): Promise<PreviewFrame | null> {
    if (this.inflight) return this.inflight;
    const pace = this.current ? frameIntervalMs(this.latency[this.current.source], this.current.source) : MIN_FRAME_INTERVAL_MS;
    if (this.current && this.client && this.now() - this.lastCaptureAt < pace * SHARE_FRAME_FRACTION) return this.current;
    this.lastCaptureAt = this.now();
    this.inflight = this.capture().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Send clicks and keys to the running game. Calls are sent one at a time,
   *  in order; input that arrives meanwhile goes out as one script. */
  async sendInput(inputs: PreviewInput[]): Promise<InputResult> {
    if (!this.client || this.state() !== "game") {
      return { ok: false, error: "No game is running; clicks and keys go only to a running game." };
    }
    if (!this.inputSupported) {
      return { ok: false, error: "This Summer Engine build cannot take input from the preview (it predates SimulateInputScript)." };
    }
    const geometry = this.current;
    const events = inputs
      .map((input) => engineInputEvent(input, geometry))
      .filter((event): event is Record<string, unknown> => event !== null);
    if (events.length === 0) return { ok: false, error: "Nothing to send: the key is not mapped, or the click is outside the frame." };
    this.inputQueue.push(...events);
    const client = this.client;
    const run = this.inputChain.then(async (): Promise<InputResult> => {
      const batch = this.inputQueue.splice(0);
      if (batch.length === 0) return { ok: true, sent: 0 };
      const built = buildGameInputOp({ action: "script", events: batch as InputEvent[], wait: false });
      try {
        const result = await client.executeOps([built.op], undefined, built.timeoutMs);
        const failure = extractOpError(result);
        return failure ? { ok: false, error: failure } : { ok: true, sent: batch.length };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    });
    this.inputChain = run.catch(() => undefined);
    return run;
  }

  private state(): PreviewState {
    if (!this.client) return this.attempted ? "no_editor" : "connecting";
    if (this.current) return this.current.source === "game" ? "game" : "editor";
    return this.playing ? "game" : "editor";
  }

  private message(state: PreviewState): string {
    switch (state) {
      case "connecting":
        return "Looking for Summer Engine";
      case "no_editor":
        return this.linkError ?? NO_EDITOR_MESSAGE;
      case "game":
        return `Game running${this.playingScene ? `: ${this.playingScene}` : ""}`;
      case "editor":
        if (this.playing && this.gameNote) return `Game running, but its frame could not be read (${this.gameNote}): showing the editor`;
        return GAME_NOT_RUNNING_MESSAGE;
    }
  }

  private drop(): void {
    this.client = null;
    this.current = null;
    this.playing = false;
    this.playingScene = null;
    this.inputSupported = false;
    this.lastConnectAt = -Infinity;
  }

  /** The connected client, connecting or following a restart as needed. */
  private async engine(): Promise<PreviewEngine | null> {
    const now = this.now();
    if (this.client && now - this.lastLinkCheckAt >= LINK_CHECK_MS) {
      this.lastLinkCheckAt = now;
      if (await this.client.credentialsChanged().catch(() => false)) this.drop();
    }
    if (this.client) return this.client;
    if (now - this.lastConnectAt < RECONNECT_MS) return null;
    this.lastConnectAt = now;
    this.attempted = true;
    try {
      const client = await this.connectEngine();
      this.client = client;
      this.linkError = null;
      this.lastLinkCheckAt = now;
      this.lastPlayCheckAt = -Infinity;
      this.lastMetaAt = -Infinity;
      this.gameBlockedUntil = -Infinity;
      this.gameNote = null;
      this.inputSupported = !missingEngineOpResult(client, "SimulateInputScript", "");
      return client;
    } catch (err) {
      const reason = errorMessage(err);
      const notRunning = engineNotRunningFromConnectError(reason);
      this.linkError = notRunning
        ? /^No running Summer editor matches/.test(reason)
          ? `Editor not running for this project: run npx -y summer-engine@latest dev`
          : null
        : `Summer Engine: ${reason.split("\n")[0]}`;
      return null;
    }
  }

  /** Whether a game runs (and which scene). False when the editor is gone. */
  private async refreshPlaying(client: PreviewEngine): Promise<boolean> {
    const now = this.now();
    if (now - this.lastPlayCheckAt < PLAY_CHECK_MS) return true;
    this.lastPlayCheckAt = now;
    try {
      const result = firstResult(await client.executeOps([{ op: "IsGameRunning" }]));
      const playing = result?.playing === true || result?.running === true;
      if (playing && !this.playing) this.gameBlockedUntil = -Infinity;
      this.playing = playing;
      this.playingScene = playing ? stringFrom(result?.scene) || null : null;
      if (!playing) this.gameNote = null;
      return true;
    } catch {
      // The editor stopped answering: look for it again.
      this.drop();
      return false;
    }
  }

  private async refreshMeta(client: PreviewEngine): Promise<void> {
    const now = this.now();
    if (now - this.lastMetaAt < META_CHECK_MS) return;
    this.lastMetaAt = now;
    const [projectState, sceneState] = await Promise.all([
      client.getProjectState().catch(() => null),
      client.getSceneState().catch(() => null),
    ]);
    if (projectState) this.project = resolveProjectName(projectState, null);
    if (sceneState || projectState) this.scene = resolveCurrentScene(projectState, sceneState, null);
  }

  private async capture(): Promise<PreviewFrame | null> {
    const client = await this.engine();
    if (!client) return null;
    if (!(await this.refreshPlaying(client))) return null;
    await this.refreshMeta(client);

    if (this.playing && this.now() >= this.gameBlockedUntil) {
      const frame = await this.read(client, "game");
      if (frame) return frame;
    }
    const frame = await this.read(client, "editor");
    if (frame) return frame;
    // Keep showing the last frame; the next status check finds a lost editor.
    this.lastPlayCheckAt = -Infinity;
    return this.current;
  }

  private async read(client: PreviewEngine, source: "game" | "editor"): Promise<PreviewFrame | null> {
    const started = this.now();
    let snap: EngineSnapshot;
    try {
      snap = source === "game" ? await client.gameSnapshot({ saveFile: false }) : await client.viewportSnapshot({ saveFile: false });
    } catch (err) {
      snap = { ok: false, error: errorMessage(err) };
    }
    const latencyMs = this.now() - started;
    if (!snap.ok || !snap.base64) {
      if (source === "game") {
        if (snap.failureReason === "not_running") {
          this.playing = false;
          this.playingScene = null;
        } else {
          this.gameNote = snap.failureReason ?? snap.error ?? "no image";
          this.gameBlockedUntil = this.now() + GAME_RETRY_MS;
        }
      }
      return null;
    }
    const previous = this.latency[source];
    this.latency[source] = previous === null ? latencyMs : previous + EWMA_WEIGHT * (latencyMs - previous);
    if (source === "game") this.gameNote = null;
    const bytes = Buffer.from(snap.base64, "base64");
    this.seq += 1;
    this.current = {
      seq: this.seq,
      source,
      bytes,
      mime: snap.mime ?? "image/png",
      width: snap.width ?? 0,
      height: snap.height ?? 0,
      sourceWidth: numberFrom(snap.metadata?.source_width),
      sourceHeight: numberFrom(snap.metadata?.source_height),
      capturedAt: this.now(),
      latencyMs,
    };
    return this.current;
  }
}
