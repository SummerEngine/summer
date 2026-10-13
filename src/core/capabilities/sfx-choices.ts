import { z } from "zod";

/**
 * Sound-effect choices (summer_generate_sfx_choices + summer_get_choices).
 *
 * Sound-effect models differ a lot from one sound to the next, so the agent
 * can make one sound with several models and let the person pick by ear:
 * POST /api/mcp/generate/audio/choices makes the versions and a choice set,
 * the person listens and approves one or more on the Studio page
 * /studio/choices/<id>, and GET /api/mcp/choices/<id> reads the decision.
 * The server queues the page for the person's open Studio tab itself
 * (studioTab.queued); only when no tab took it does this open a browser.
 * An approval makes that model the person's default for later
 * summer_generate_audio sound_effects calls without a modelId.
 *
 * One implementation for both faces: the MCP tools (generate-tools.ts) and
 * `summer tool generate-sfx-choices` / `get-choices` (tool-dispatch.ts) pass
 * their own gateway request functions and share everything else here.
 */

export const SFX_MODEL_IDS = ["eleven_text_to_sound_v2", "sonilo-sfx-1.1", "stable-audio-3-sfx"] as const;
export type SfxModelId = (typeof SFX_MODEL_IDS)[number];

export const SFX_CHOICES_ENDPOINT = "/api/mcp/generate/audio/choices";
export const CHOICES_ENDPOINT_PREFIX = "/api/mcp/choices/";
/** Three models run in parallel on the server; the slowest decides. */
export const SFX_CHOICES_TIMEOUT_MS = 240_000;
export const MAX_CHOICES_WAIT_SECONDS = 50;

export const sfxChoicesArgsSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(450)
    .describe("The sound to make, written as a Foley description (what hits what, the attack and the tail, close-mic, dry)"),
  durationSeconds: z
    .number()
    .positive()
    .max(30)
    .optional()
    .describe("Exact length in seconds. One-shots 0.5-2; animation-synced sounds match the animation. stable-audio-3-sfx needs >= 1, sonilo-sfx-1.1 >= 0.5"),
  loop: z
    .boolean()
    .optional()
    .describe("Ask for a seamless loop (eleven_text_to_sound_v2 only; say 'seamless loop' in text too)"),
  models: z
    .array(z.enum(SFX_MODEL_IDS))
    .min(2)
    .max(4)
    .optional()
    .describe("2-4 model ids to compare. Default: eleven_text_to_sound_v2, sonilo-sfx-1.1, stable-audio-3-sfx"),
  idempotencyKey: z.string().min(1).max(128).optional().describe("Choose one stable key before generating. Reuse it only for the exact same request after an uncertain result; a different sound needs a new key"),
  open: z
    .boolean()
    .default(true)
    .describe("Show the choices page in the browser when no open Studio tab took it. false: no browser, only return the URL"),
});
export type SfxChoicesArgs = z.input<typeof sfxChoicesArgsSchema>;

export const getChoicesArgsSchema = z.object({
  choiceSetId: z.string().min(1).max(200).describe("The choiceSetId from summer_generate_sfx_choices"),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_CHOICES_WAIT_SECONDS)
    .optional()
    .describe("Wait up to this many seconds (max 50) for the person to decide before answering. 0 or omitted: answer now"),
});
export type GetChoicesArgs = z.input<typeof getChoicesArgsSchema>;

/** A gateway reply as both faces' request helpers produce it. */
export interface GatewayReply {
  data?: any;
  error?: string;
  status: number;
  phase?: "not_sent" | "outcome_unknown";
}

export interface SfxChoicesDeps {
  post(endpoint: string, body: Record<string, unknown>, timeoutMs: number): Promise<GatewayReply>;
  get(endpoint: string, params: URLSearchParams, timeoutMs: number): Promise<GatewayReply>;
  openUrl(url: string): Promise<unknown>;
  canOpenBrowser(): boolean;
}

/** `studio_tab` means the open command was queued, not that the page rendered. */
export type ShownIn = "studio_tab" | "browser" | "not_opened";

interface Clip {
  clipId?: string;
  modelId?: string;
  modelName?: string;
  audioUrl?: string;
  assetId?: string;
  durationSeconds?: number;
  approved?: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Showing the page
// ---------------------------------------------------------------------------

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isSummerHost(host: string | null): boolean {
  return host === "summerengine.com" || (host?.endsWith(".summerengine.com") ?? false);
}

function isLoopback(host: string | null): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** Same rule as summer_open: a browser only ever opens summerengine.com, its subdomains, or loopback. */
export function canOpenReviewUrl(url: string): boolean {
  const host = hostOf(url);
  return isSummerHost(host) || isLoopback(host);
}

/** False where a browser launch cannot reach the person: CI, or Linux with no display. */
export function defaultCanOpenBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.CI) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

/** The server's studioTab answer: queued for the person's open tab, or why not. Missing on older servers. */
function studioTabAnswer(value: unknown): { queued: boolean; reason?: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    queued: record.queued === true,
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
}

async function showChoicesPage(
  reviewUrl: string,
  studioTab: { queued: boolean; reason?: string } | null,
  deps: SfxChoicesDeps
): Promise<{ shown: ShownIn; studioTab?: string; browser?: string }> {
  const notQueued = studioTab ? (studioTab.reason ?? "not_queued") : undefined;
  if (!canOpenReviewUrl(reviewUrl)) return { shown: "not_opened", studioTab: notQueued, browser: "not_a_summer_url" };
  if (!deps.canOpenBrowser()) return { shown: "not_opened", studioTab: notQueued, browser: "no_browser_here" };
  try {
    await deps.openUrl(reviewUrl);
    return { shown: "browser", studioTab: notQueued };
  } catch (error) {
    return { shown: "not_opened", studioTab: notQueued, browser: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// summer_generate_sfx_choices
// ---------------------------------------------------------------------------

export function sfxChoicesRequestBody(args: z.output<typeof sfxChoicesArgsSchema>): Record<string, unknown> {
  const body: Record<string, unknown> = { capability: "sound_effects", text: args.text };
  if (args.durationSeconds !== undefined) body.durationSeconds = args.durationSeconds;
  if (args.loop !== undefined) body.loop = args.loop;
  if (args.models) body.models = args.models;
  if (args.idempotencyKey !== undefined) body.idempotencyKey = args.idempotencyKey;
  return body;
}

function recoveryAdvice(key: string | undefined): string {
  return key
    ? "The result or charge is unknown. Check existing choices, your asset library and credits before any retry. If you retry this same attempt, keep the exact request and idempotencyKey; server replay records may expire after 24 hours, so a later retry may start and bill new work."
    : "The result or charge is unknown. No retry key was sent. Check existing choices, your asset library and credits; do not start another paid call blindly.";
}

function knownRefusal(reply: GatewayReply): boolean {
  if (reply.phase === "not_sent") return true;
  if (reply.phase === "outcome_unknown") return false;
  if ([400, 401, 402, 403, 422, 429].includes(reply.status)) return true;
  if (reply.status === 503 && reply.data?.error === "idempotency_unavailable") return true;
  return false;
}

function validClip(value: unknown): value is Clip {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const clip = value as Record<string, unknown>;
  return ["clipId", "modelId", "audioUrl", "assetId"].every((field) => typeof clip[field] === "string" && (clip[field] as string).length > 0);
}

function clipSummary(clip: Clip) {
  return {
    clipId: clip.clipId,
    modelId: clip.modelId,
    modelName: clip.modelName,
    audioUrl: clip.audioUrl,
    assetId: clip.assetId,
    durationSeconds: clip.durationSeconds,
  };
}

export async function generateSfxChoices(
  args: z.output<typeof sfxChoicesArgsSchema>,
  deps: SfxChoicesDeps
): Promise<Record<string, unknown>> {
  const reply = await deps.post(SFX_CHOICES_ENDPOINT, sfxChoicesRequestBody(args), SFX_CHOICES_TIMEOUT_MS);
  const key = args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey };
  if (reply.error) {
    const refused = knownRefusal(reply);
    return {
      ok: false,
      ...key,
      status: reply.status,
      outcome: refused ? "refused" : "unknown",
      error: reply.error,
      ...(reply.data !== undefined ? { details: reply.data } : {}),
      ...(refused && args.idempotencyKey !== undefined
        ? { note: "This request was refused before new work. It does not prove an earlier call with this key was uncharged; check choices, assets and credits." }
        : {}),
      ...(!refused ? { recovery: recoveryAdvice(args.idempotencyKey) } : {}),
    };
  }
  const data = reply.data ?? {};
  const clips: Clip[] = Array.isArray(data.clips) ? data.clips : [];
  const failed = Array.isArray(data.failed) ? data.failed : [];
  const choiceSetId = typeof data.choiceSetId === "string" ? data.choiceSetId : null;
  const reviewUrl = typeof data.reviewUrl === "string" ? data.reviewUrl : null;
  const studioPath = typeof data.studioPath === "string" ? data.studioPath : undefined;

  if (!choiceSetId || !reviewUrl || clips.length === 0 || !clips.every(validClip)) {
    return {
      ok: false,
      ...key,
      status: reply.status,
      outcome: "unknown",
      error: "The server response did not confirm a completed choice set.",
      details: reply.data,
      recovery: recoveryAdvice(args.idempotencyKey),
    };
  }

  // The server queued the Studio-tab open already; that happens even with
  // open:false, so report it rather than hide it.
  const studioTab = studioTabAnswer(data.studioTab);
  const shown: { shown: ShownIn; studioTab?: string; browser?: string } = studioTab?.queued
    ? { shown: "studio_tab" }
    : args.open
      ? await showChoicesPage(reviewUrl, studioTab, deps)
      : { shown: "not_opened", browser: "open_false" };

  const count = clips.length;
  const where =
    shown.shown === "studio_tab"
      ? `I sent them to your Summer Studio tab. If the page does not appear, open ${reviewUrl}`
      : shown.shown === "browser"
        ? "I opened them in your browser"
        : `Open ${reviewUrl} to hear them`;
  const say = `${data.replayed === true ? "I found" : "I made"} ${count} versions of this sound with ${count} different models. ${where}. Listen, approve the ones you like (one or more), then tell me. The model you approve becomes your default for sound effects.`;

  return {
    ok: true,
    ...key,
    choiceSetId,
    prompt: typeof data.prompt === "string" ? data.prompt : args.text,
    reviewUrl,
    ...(studioPath ? { studioPath } : {}),
    shown: shown.shown,
    ...(shown.studioTab || shown.browser
      ? { notShownBecause: { ...(shown.studioTab ? { studioTab: shown.studioTab } : {}), ...(shown.browser ? { browser: shown.browser } : {}) } }
      : {}),
    clips: clips.map(clipSummary),
    failed,
    ...(Array.isArray(data.notes) ? { notes: data.notes.filter((note: unknown): note is string => typeof note === "string") } : {}),
    ...(typeof data.costUsd === "number" && Number.isFinite(data.costUsd) ? { costUsd: data.costUsd } : {}),
    ...(data.price && typeof data.price === "object" ? { price: data.price } : {}),
    ...(data.replayed === true ? { replayed: true } : {}),
    say,
    next: `Tell the person the "say" text. A queued Studio tab is not proof the page appeared; the text includes reviewUrl as a fallback. Do not pick for them. Then call summer_get_choices with choiceSetId "${choiceSetId}" and waitSeconds ${MAX_CHOICES_WAIT_SECONDS}; call it again while status is "pending".`,
  };
}

// ---------------------------------------------------------------------------
// summer_get_choices
// ---------------------------------------------------------------------------

function fileExtension(url: string | undefined): string {
  if (!url) return "wav";
  try {
    const match = /\.(wav|mp3|ogg)$/i.exec(new URL(url).pathname);
    return match ? match[1].toLowerCase() : "wav";
  } catch {
    return "wav";
  }
}

export function choicesEndpoint(choiceSetId: string): string {
  return `${CHOICES_ENDPOINT_PREFIX}${encodeURIComponent(choiceSetId)}`;
}

export function choicesTimeoutMs(waitSeconds: number | undefined): number {
  return ((waitSeconds ?? 0) + 20) * 1000;
}

export async function getChoices(
  args: z.output<typeof getChoicesArgsSchema>,
  deps: Pick<SfxChoicesDeps, "get">
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  if (args.waitSeconds) params.set("waitSeconds", String(args.waitSeconds));
  const reply = await deps.get(choicesEndpoint(args.choiceSetId), params, choicesTimeoutMs(args.waitSeconds));
  if (reply.error) {
    return { ok: false, error: reply.error, ...(reply.data ? { details: reply.data } : {}) };
  }
  const data = reply.data ?? {};
  const clips: Clip[] = Array.isArray(data.clips) ? data.clips : [];
  const status = data.status === "decided" ? "decided" : "pending";
  const approved = clips
    .filter((clip) => clip.approved === true)
    .map((clip) => ({
      ...clipSummary(clip),
      ...(clip.note ? { note: clip.note } : {}),
      fileExtension: fileExtension(clip.audioUrl),
    }));

  let next: string;
  if (status === "pending") {
    next = `The person has not decided yet. Call summer_get_choices again with waitSeconds ${MAX_CHOICES_WAIT_SECONDS}, or wait until they say they picked. Do not pick for them.`;
  } else if (approved.length === 0) {
    next = "They approved none. Ask what to change (the description, the length, the models) and run summer_generate_sfx_choices again.";
  } else {
    next =
      "Import each approved clip into the project: summer_import_from_url({ url: audioUrl, path: \"res://audio/sfx/<name>.<fileExtension>\" }) " +
      "or summer_import_asset_by_id({ assetId, path }). Read each clip's note. Then wire it (sound-effect skill, step Wire). " +
      (typeof data.preferredModelId === "string"
        ? `Their default sound-effect model is now ${data.preferredModelId}: later summer_generate_audio sound_effects calls without modelId use it.`
        : "");
  }

  return {
    ok: true,
    choiceSetId: typeof data.choiceSetId === "string" ? data.choiceSetId : args.choiceSetId,
    kind: data.kind,
    prompt: data.prompt,
    status,
    preferredModelId: data.preferredModelId ?? null,
    approved,
    clips: clips.map((clip) => ({ ...clipSummary(clip), approved: clip.approved === true, ...(clip.note ? { note: clip.note } : {}) })),
    next: next.trim(),
  };
}
