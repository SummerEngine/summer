import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BOARD_ENDPOINT, boardArgsSchema, boardContent, boardQuery } from "../../core/capabilities/board.js";
import { IMAGE_GENERATION_TIMEOUT_MS, imageGenerationArgsSchema, saveGeneratedImage } from "../../core/capabilities/image-generation.js";
import {
  buildMotionRequestBody,
  motionErrorHint,
  motionGenerationArgsSchema,
  motionJobFailureHint,
} from "../../core/capabilities/motion-generation.js";
import {
  MAX_CHOICES_WAIT_SECONDS,
  defaultCanOpenBrowser,
  generateSfxChoices,
  getChoices,
  getChoicesArgsSchema,
  sfxChoicesArgsSchema,
  SFX_CHOICES_ENDPOINT,
  type SfxChoicesDeps,
} from "../../core/capabilities/sfx-choices.js";
import open from "open";
import { getAuthToken } from "../../core/auth.js";
import { resolveGatewayUrl } from "../../core/config.js";
import { readJsonResponse } from "../../core/util/http.js";
import { asRecord, stringFrom } from "../../core/util/json.js";
import { summerRequestHeaders } from "../../core/agent-host.js";
import {
  codedFailure,
  codeForStatus,
  describeNetworkError,
  networkDetails,
  NOT_SIGNED_IN,
  SIGN_IN_AGAIN_RECOVERY,
  type SummerErrorCode,
} from "../../core/error-codes.js";

const TOOL_BY_ENDPOINT: Record<string, string> = {
  "/api/mcp/generate/image": "summer_generate_image",
  "/api/mcp/generate/audio": "summer_generate_audio",
  [SFX_CHOICES_ENDPOINT]: "summer_generate_sfx_choices",
  "/api/mcp/generate/3d": "summer_generate_3d",
  "/api/mcp/generate/video": "summer_generate_video",
  "/api/mcp/generate/motion": "summer_generate_motion",
  "/api/mcp/generate/slice-asset-sheet": "summer_slice_asset_sheet",
  "/api/mcp/workflows": "summer_get_studio_workflow",
  [BOARD_ENDPOINT]: "summer_get_board",
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function formatValidationDetailEntry(entry: unknown): string | null {
  const record = asRecord(entry);
  if (!record) {
    return stringFrom(entry) ?? null;
  }

  const message =
    stringFrom(record.msg) ??
    stringFrom(record.message) ??
    stringFrom(record.error) ??
    null;
  if (!message) return null;

  const loc = Array.isArray(record.loc)
    ? record.loc.map((part) => String(part)).join(".")
    : stringFrom(record.path) ?? stringFrom(record.field);

  return loc ? `${loc}: ${message}` : message;
}

function formatValidationDetails(detail: unknown): string[] {
  if (Array.isArray(detail)) {
    return detail
      .map(formatValidationDetailEntry)
      .filter((entry): entry is string => !!entry);
  }
  const formatted = formatValidationDetailEntry(detail);
  return formatted ? [formatted] : [];
}

function formattedApiErrorMessage(status: number, data: unknown): string {
  const record = asRecord(data);
  const provider = asRecord(record?.provider);
  const directDetailMessages = formatValidationDetails(record?.detail);
  const detailMessages =
    directDetailMessages.length > 0
      ? directDetailMessages
      : Array.isArray(provider?.detailMessages)
        ? provider.detailMessages.filter((entry): entry is string => typeof entry === "string")
        : formatValidationDetails(provider?.detail);

  if (status === 422 && detailMessages.length > 0) {
    return `Request validation failed (422): ${detailMessages.join("; ")}`;
  }

  return (
    stringFrom(record?.message) ??
    stringFrom(record?.error) ??
    `Request failed (${status})`
  );
}

/** Lenient body read for Studio generation endpoints: {} for an empty body,
 *  {message} for a non-JSON one, so callers can always index the result. */
async function readLenientJson(res: Response): Promise<any> {
  const { text, json, parsed } = await readJsonResponse(res);
  if (parsed) return json;
  return text ? { message: text.slice(0, 1000) } : {};
}

/** A Summer web reply. `code` (and a `recovery` that differs from the
 *  default) is set for the shared failures in core/error-codes.ts. */
type GatewayResult = { data?: any; error?: string; status: number; code?: SummerErrorCode; recovery?: string };

/** The coded failure for a non-OK reply: 401 (token expired) and 402 (no
 *  credits) carry the shared codes. */
function statusFailure(status: number): Pick<GatewayResult, "code" | "recovery"> {
  const code = codeForStatus(status);
  if (!code) return {};
  return code === "not_signed_in" ? { code, recovery: SIGN_IN_AGAIN_RECOVERY } : { code };
}

async function mcpGenerate(
  endpoint: string,
  body: Record<string, any>,
  timeoutMs = 120_000
): Promise<GatewayResult> {
  const token = await getAuthToken();
  if (!token) {
    return { error: NOT_SIGNED_IN, status: 401, code: "not_signed_in" };
  }

  const gatewayUrl = await resolveGatewayUrl();
  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}${endpoint}`, {
      method: "POST",
      headers: {
        ...summerRequestHeaders({ tool: TOOL_BY_ENDPOINT[endpoint], surface: "mcp" }),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Summer-MCP-Endpoint": endpoint,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { error: `Generation request failed: ${describeNetworkError(err)}`, status: 0, code: "unavailable", data: networkDetails(err) };
  }

  const data = await readLenientJson(res);
  if (!res.ok) {
    let message = formattedApiErrorMessage(res.status, data);
    // The next step (Add credits, sign in again) rides in `recovery`.
    if (res.status === 402) message = String(data.message || "Not enough credits.");
    if (res.status === 401) message = String(data.message || "Auth token expired.");
    return { error: message, data: { ...data, status: res.status }, status: res.status, ...statusFailure(res.status) };
  }
  return { data, status: res.status };
}

async function mcpGet(
  endpoint: string,
  searchParams?: URLSearchParams,
  timeoutMs = 30_000
): Promise<GatewayResult> {
  const token = await getAuthToken();
  const suffix = searchParams?.size ? `?${searchParams.toString()}` : "";
  const gatewayUrl = await resolveGatewayUrl();
  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}${endpoint}${suffix}`, {
      headers: {
        ...summerRequestHeaders({ tool: TOOL_BY_ENDPOINT[endpoint], surface: "mcp" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-Summer-MCP-Endpoint": endpoint,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { error: `Request failed: ${describeNetworkError(err)}`, status: 0, code: "unavailable", data: networkDetails(err) };
  }

  const data = await readLenientJson(res);
  if (!res.ok) {
    return {
      error: formattedApiErrorMessage(res.status, data),
      data: { ...data, status: res.status },
      status: res.status,
      // Without a token a 401 means "sign in", not "sign in again".
      ...(!token && res.status === 401 ? { code: "not_signed_in" as const } : statusFailure(res.status)),
    };
  }
  return { data, status: res.status };
}

/**
 * Poll a job until completed, failed, or timeout.
 * Returns the final job status object.
 */
async function pollJob(
  jobId: string,
  maxWaitMs = 600_000,
  intervalMs = 5_000
): Promise<Omit<GatewayResult, "status">> {
  const token = await getAuthToken();
  if (!token) return { error: NOT_SIGNED_IN, code: "not_signed_in" };

  const gatewayUrl = await resolveGatewayUrl();
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${gatewayUrl}/api/mcp/jobs/${encodeURIComponent(jobId)}`,
        {
          headers: { ...summerRequestHeaders({ surface: "mcp" }), Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        }
      );

      const data = await readLenientJson(res);
      if (!res.ok) return { error: data.message || "Poll failed", data, ...statusFailure(res.status) };

      if (data.status === "completed") return { data };
      if (data.status === "failed") return { error: data.error || "Job failed", data };

      // Still running — wait and retry
      await new Promise((r) => setTimeout(r, intervalMs));

      // Back off slightly after 30s
      if (Date.now() - (deadline - maxWaitMs) > 30_000) {
        intervalMs = Math.min(intervalMs * 1.2, 15_000);
      }
    } catch (err) {
      return { error: `Poll error: ${describeNetworkError(err)}`, code: "unavailable", data: networkDetails(err) };
    }
  }

  return { error: `Timed out after ${maxWaitMs / 1000}s. Use summer_check_job({ jobId: "${jobId}" }) to check later.` };
}

/** A failed tool call. With a shared code (core/error-codes.ts) the body is
 *  `{ok:false, code, error, recovery, …, message}`; otherwise the older
 *  `{error:true, …, message}`. */
function errorResult(message: string, extra?: Record<string, any>, coded?: Pick<GatewayResult, "code" | "recovery">) {
  const body = coded?.code
    ? codedFailure(coded.code, message, { ...extra, message }, coded.recovery)
    : { error: true, ...extra, message };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(body, null, 2),
      },
    ],
    isError: true,
  };
}

/** The step after a generation job starts (the hosted tools answer the same way). */
function checkJobNext(jobId: string): string {
  return `The job runs on Summer's servers. Poll summer_check_job({ jobId: "${jobId}" }) every 15-30 seconds until status is "completed".`;
}

function successResult(data: any) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGenerateTools(server: McpServer): void {
  // ========================================================================
  // summer_get_studio_workflow
  // ========================================================================
  server.tool(
    "summer_get_studio_workflow",
    `Discover the same Guided workflow recipes shown in Summer Engine Studio.

Call without workflowId to list every workflow and its support level. Call with
an id to get the exact starter prompt, ordered steps, required MCP tools, and
honest limitations. A "manual" support level means Studio still has a visual
handoff that MCP cannot perform automatically; do not pretend that stage ran.`,
    {
      workflowId: z
        .string()
        .optional()
        .describe("Guided workflow id, e.g. sprite-sheet, character-pack, asset-pack, or component-compiler"),
    },
    async ({ workflowId }) => {
      const params = new URLSearchParams();
      if (workflowId) params.set("id", workflowId);
      const result = await mcpGet("/api/mcp/workflows", params);
      if (result.error) return errorResult(result.error, result.data, result);
      return successResult(result.data);
    }
  );

  // ========================================================================
  // summer_get_board
  // ========================================================================
  server.tool(
    "summer_get_board",
    `Read the person's approved planning board for this game: the look (palette,
description, picture), the characters, the place, the first-minute storyboard
and the cards they picked, with a version that changes when the board does.

The look and the picked cards come back as images you can see. Read the board at
the start of each build step and compare your screenshot against its images
(palette, shapes and proportions, camera angle, composition); fix the biggest
difference. Use the picked card pictures as referenceImageUrl for
summer_generate_image to make sprites and backgrounds in the same look.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    boardArgsSchema.shape,
    async (args) => {
      const result = await mcpGet(BOARD_ENDPOINT, boardQuery(args), 45_000);
      if (result.error) return errorResult(result.error, result.data, result);
      return { content: boardContent(result.data ?? {}) };
    }
  );

  // ========================================================================
  // summer_generate_image
  // ========================================================================
  server.tool(
    "summer_generate_image",
    `Generate an image using AI models via Summer Engine Studio.

Known models:
  - "nano-banana-2" — High quality, supports txt2img and img2img (used when no
    model and no size is asked)
  - "gemini-flash" — Google Gemini 2.5 Flash, fast
  - "flux-2" — FLUX.2, good for specific styles

Model ids are an ALLOWLIST, not a passthrough. An unrecognised id is rejected
with 400 and the response lists every accepted id — it is not silently swapped.

Two modes:
  - txt2img (default): just pass prompt
  - img2img (edit): pass prompt + referenceImageUrl to edit/transform an existing image

Style presets: "realistic" (default), "cartoon", "anime", "none"

For an alpha PNG, set removeBackground: true. Prompt wording alone does not
guarantee transparency; background removal runs server-side after generation.

Size: aspectRatio (1:1, 16:9, 9:16, 4:3, 3:4, ...) or width + height (the
smallest size you need). For store art ask width 1920 height 1080 (key art)
or width 1080 height 1920 (tall cover): the server picks a model that reaches
that size when model is omitted, or refuses a named model that cannot, before
anything is spent. Larger models can take over a minute; the call waits up to
3 minutes.
Each result reports the real width and height and the model that ran.

'options' carries extra model params (seed, negative_prompt, ...); the result
lists any the server did not use in ignoredOptions.

Returns the asset with fileUrl (hosted) and localPath: the file on disk, in
'out' (a folder, or a .png/.jpg/.webp path) or else <TMPDIR>/summer-gen/.
Use the Read tool on localPath to show the image to the user for approval.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    imageGenerationArgsSchema.shape,
    async ({ prompt, model, style, referenceImageUrl, removeBackground, aspectRatio, width, height, options, out }) => {
      const result = await mcpGenerate(
        "/api/mcp/generate/image",
        {
          prompt,
          model,
          style,
          referenceImageUrl,
          removeBackground,
          aspectRatio,
          width,
          height,
          options,
        },
        IMAGE_GENERATION_TIMEOUT_MS
      );

      if (result.error) {
        return errorResult(result.error, result.data, result);
      }

      // Download to temp so the AI can Read and show the image
      const imageUrl =
        result.data?.asset?.fileUrl || result.data?.asset?.thumbnailUrl;
      let localPath: string | null = null;
      if (imageUrl) {
        localPath = await saveGeneratedImage(imageUrl, out);
      }

      return successResult({
        ...result.data,
        localPath,
        hint: localPath
          ? `Image saved to ${localPath}. Use the Read tool on this path to show it to the user.`
          : undefined,
      });
    }
  );

  // ========================================================================
  // summer_slice_asset_sheet
  // ========================================================================
  server.tool(
    "summer_slice_asset_sheet",
    `Detect and crop every distinct game asset from an existing image asset sheet.

Use the assetId returned by summer_generate_image (or another Summer image asset).
The same guided workflow used in Studio removes the sheet background when needed,
detects named/category-aware bounding boxes, crops each item, and uploads the slices.

Returns source dimensions plus the generated slice URLs, names, categories, bounding
boxes, and widget metadata when the sheet contains UI controls.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    {
      assetId: z
        .string()
        .describe(
          "Summer image asset ID to slice, usually returned by summer_generate_image"
        ),
    },
    async ({ assetId }) => {
      const result = await mcpGenerate(
        "/api/mcp/generate/slice-asset-sheet",
        { assetId },
        300_000
      );

      if (result.error) {
        return errorResult(result.error, result.data, result);
      }

      return successResult({
        ...result.data,
        sliceCount: Array.isArray(result.data?.slices)
          ? result.data.slices.length
          : 0,
      });
    }
  );

  // ========================================================================
  // summer_generate_audio
  // ========================================================================
  server.tool(
    "summer_generate_audio",
    `Generate audio using AI providers via Summer Engine Studio.

Capabilities:
  - "text_to_speech" — Convert text to spoken audio. Requires 'text'. Optional 'voiceId'.
  - "sound_effects" — Generate sound effects from description. Requires 'text'. Optional 'durationSeconds', 'modelId', 'loop'.
  - "music" — Generate background music. Requires 'prompt'. Optional 'durationSeconds'.
  - "text_to_dialogue" — Multi-voice dialogue. Requires 'inputs' array of {text, voiceId} objects.

Sound-effect models (modelId; omit it to use the person's approved default,
else ElevenLabs):
  - "eleven_text_to_sound_v2" — ElevenLabs SFX v2. Strong all-rounder, 0.5-30 s,
    the only one that makes seamless loops (loop: true).
  - "sonilo-sfx-1.1" — Sonilo SFX 1.1. Strong all-rounder, >= 0.5 s.
  - "stable-audio-3-sfx" — Stable Audio 3 SFX. Sometimes best on fast movement
    (swings, whooshes), less consistent; >= 1 s.
The best model changes a lot from one sound to the next. For the first sound
effect in a chat, offer the person three versions to pick from by ear:
summer_generate_sfx_choices.

The 'options' object is spread into the ElevenLabs SDK call at the TOP level, so
only keys the SDK accepts there have any effect. Voice tuning is NOT top-level and
is NOT snake_case: pass it as options.voiceSettings with camelCase keys —
{ voiceSettings: { stability, similarityBoost, style, speed, useSpeakerBoost } }.
Flat snake_case keys are accepted by the schema, silently dropped by the SDK, and
return a normal 200 with the setting ignored.

Returns the generated audio URL and asset metadata.
Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    {
      capability: z
        .string()
        .describe("Type of audio: text_to_speech, sound_effects, music, text_to_dialogue"),
      text: z
        .string()
        .optional()
        .describe("Text for TTS, or description for sound effects"),
      prompt: z
        .string()
        .optional()
        .describe("Music description (for 'music' capability)"),
      voiceId: z
        .string()
        .optional()
        .describe("ElevenLabs voice ID for TTS"),
      modelId: z
        .string()
        .optional()
        .describe(
          "Model id. text_to_speech: an ElevenLabs model (e.g. 'eleven_multilingual_v2'). " +
          "sound_effects: eleven_text_to_sound_v2, sonilo-sfx-1.1 or stable-audio-3-sfx; omit to use the person's approved default"
        ),
      durationSeconds: z
        .number()
        .optional()
        .describe("Duration in seconds for SFX or music"),
      loop: z
        .boolean()
        .optional()
        .describe("sound_effects only: ask for a seamless loop (eleven_text_to_sound_v2 only)"),
      inputs: z
        .array(z.object({ text: z.string(), voiceId: z.string() }))
        .optional()
        .describe("Dialogue lines for text_to_dialogue"),
      options: z
        .record(z.any())
        .optional()
        .describe(
          "Provider params, spread at the SDK's top level. Voice tuning goes in " +
          "options.voiceSettings with camelCase keys (stability, similarityBoost, " +
          "style, speed, useSpeakerBoost); flat snake_case is silently ignored."
        ),
    },
    async ({ capability, text, prompt, voiceId, modelId, durationSeconds, loop, inputs, options }) => {
      const body: Record<string, any> = { capability };
      if (text) body.text = text;
      if (prompt) body.prompt = prompt;
      if (voiceId) body.voiceId = voiceId;
      if (modelId) body.modelId = modelId;
      if (durationSeconds) body.durationSeconds = durationSeconds;
      if (loop !== undefined) body.loop = loop;
      if (inputs) body.inputs = inputs;
      if (options) body.options = options;

      const result = await mcpGenerate("/api/mcp/generate/audio", body);

      if (result.error) {
        return errorResult(result.error, result.data, result);
      }

      return successResult(result.data);
    }
  );

  // ========================================================================
  // summer_generate_sfx_choices + summer_get_choices
  // Shared implementation: core/capabilities/sfx-choices.ts
  // ========================================================================
  const sfxChoicesDeps: SfxChoicesDeps = {
    post: (endpoint, body, timeoutMs) => mcpGenerate(endpoint, body, timeoutMs),
    get: (endpoint, params, timeoutMs) => mcpGet(endpoint, params, timeoutMs),
    openUrl: (url) => open(url),
    canOpenBrowser: () => defaultCanOpenBrowser(),
  };

  server.tool(
    "summer_generate_sfx_choices",
    `Make one sound effect with several models (default three) and show the
versions to the person on a Summer Studio page, where they listen and approve
one or more. The approved model becomes their default for sound effects.

Use it for the first sound effect in a chat after the person said yes to
"three versions to pick from", or whenever they want to compare. The page
opens in their open Summer Studio tab when there is one, else in the browser
(open:false skips the browser and only returns reviewUrl).

Then tell the person the returned "say" text and call summer_get_choices
with the choiceSetId. Do not pick for them.

Models: eleven_text_to_sound_v2 (0.5-30 s, loops), sonilo-sfx-1.1 (>= 0.5 s),
stable-audio-3-sfx (>= 1 s; give durationSeconds >= 1 when it is included).
Each version is a billed generation.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    sfxChoicesArgsSchema.shape,
    async (args) => {
      const result = await generateSfxChoices(sfxChoicesArgsSchema.parse(args), sfxChoicesDeps);
      return result.ok ? successResult(result) : errorResult(String(result.error), result);
    }
  );

  server.tool(
    "summer_get_choices",
    `Read a sound-effect choice set from summer_generate_sfx_choices: whether the
person decided ("pending" or "decided"), which versions they approved (with
audioUrl, assetId and their note) and their default sound-effect model.

waitSeconds (max ${MAX_CHOICES_WAIT_SECONDS}) waits for the decision before answering; call again
while status is "pending". Import each approved clip with
summer_import_from_url (url: audioUrl, path: res://audio/sfx/<name>.<fileExtension>)
or summer_import_asset_by_id (assetId), then wire it.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    getChoicesArgsSchema.shape,
    async (args) => {
      const result = await getChoices(getChoicesArgsSchema.parse(args), sfxChoicesDeps);
      return result.ok ? successResult(result) : errorResult(String(result.error), result);
    }
  );

  // ========================================================================
  // summer_generate_3d
  // ========================================================================
  server.tool(
    "summer_generate_3d",
    `Generate a 3D model via Summer Engine Studio.

Available models:
  - "hunyuan" (default) — Hunyuan 3D v3.1 Pro, high quality
  - "trellis" — Trellis 2, fast and detailed
  - "meshy" — Meshy, legacy option

Model ids are an ALLOWLIST, not a passthrough. An unrecognised id is rejected
with 400 listing the accepted ids.

Available kinds:
  - "text-to-3d" (default) — From text description. Requires 'prompt'.
    Internally generates a 3D-optimized reference image first, then converts to 3D.
  - "image-to-3d" — From your own image. Requires 'imageUrl'.
  - "texture" — Generate textures for a model. Requires 'imageUrl'.

Optional rig pass (image-to-3d only):
  Set options.rig = true to add an auto-rig pass via Meshy v6. The result
  job (poll via summer_check_job) will include rigAssetId — the asset ID
  of the rigged glb. Use that rigAssetId with summer_generate_motion to
  add animation clips. Adds ~60s to the job.

Example:
  summer_generate_3d({
    kind: "image-to-3d",
    imageUrl: "https://...",
    options: { rig: true }
  })
  // Returns jobId; poll until result includes { assetId, rigAssetId }.

Single-image generation automatically assesses whether the source is suitable
for 3D. If needed, Summer prepares an isolated object view or rig-safe character
pose before conversion. Set referencePreparation="always" or "never" only when
you intentionally want to override that shared Studio behavior.

For a complete animated humanoid package, pass rig=true plus animationNames or
actionIds. This routes through the shared character pipeline instead of a
one-off mesh job.

Returns a jobId within seconds. Poll summer_check_job with it until status is
"completed" (most models take 1-5 minutes; tell the user it is running and keep
working meanwhile). wait=true blocks up to 10 minutes instead.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    {
      prompt: z
        .string()
        .optional()
        .describe("Description of the 3D model, e.g. 'a low-poly treasure chest'"),
      kind: z
        .string()
        .default("text-to-3d")
        .describe("Generation type: text-to-3d, image-to-3d, texture"),
      model: z
        .string()
        .default("hunyuan")
        .describe("Model: hunyuan (default), trellis, meshy, or any fal-ai model ID"),
      imageUrl: z
        .string()
        .optional()
        .describe("Source image URL for image-to-3d or texture"),
      imageUrls: z
        .array(z.string())
        .max(4)
        .optional()
        .describe("Up to four views for multi-image-to-3d"),
      title: z.string().optional().describe("Asset or character title"),
      idempotencyKey: z
        .string()
        .optional()
        .describe("Stable retry key so the same logical request is not billed or queued twice"),
      assetIntent: z
        .enum(["character", "object"])
        .optional()
        .describe("Controls whether hidden reference preparation targets a rig-safe character pose or isolated object view"),
      referencePreparation: z
        .enum(["auto", "always", "never"])
        .default("auto")
        .describe("Shared Studio reference-preparation policy; auto is recommended"),
      rig: z.boolean().default(false).describe("Auto-rig the generated model"),
      animationNames: z
        .array(z.string())
        .optional()
        .describe("Animation names for the shared animated-character pipeline, e.g. Idle, Walk, Run, Jump"),
      actionIds: z
        .array(z.number().int().min(0).max(696))
        .optional()
        .describe("Exact Meshy action ids for the shared animated-character pipeline"),
      riggingHeightMeters: z
        .number()
        .positive()
        .max(10)
        .optional()
        .describe("Character height used by auto-rigging"),
      wait: z
        .boolean()
        .default(false)
        .describe("Block until the job finishes (up to 10 min) and return the result. Default false returns the jobId at once; poll summer_check_job."),
      options: z
        .record(z.any())
        .optional()
        .describe("Provider-specific params (target_polycount, topology, art_style, etc.)"),
    },
    async ({
      prompt,
      kind,
      model,
      imageUrl,
      imageUrls,
      title,
      idempotencyKey,
      assetIntent,
      referencePreparation,
      rig,
      animationNames,
      actionIds,
      riggingHeightMeters,
      wait,
      options,
    }) => {
      const mergedOptions = {
        ...(options ?? {}),
        ...(imageUrls ? { imageUrls } : {}),
        ...(assetIntent ? { assetIntent } : {}),
        referencePreparation,
        ...(rig ? { rig: true } : {}),
        ...(animationNames ? { animationNames } : {}),
        ...(actionIds ? { actionIds } : {}),
        ...(riggingHeightMeters !== undefined ? { riggingHeightMeters } : {}),
      };
      const result = await mcpGenerate("/api/mcp/generate/3d", {
        prompt,
        kind,
        model,
        imageUrl,
        title,
        idempotencyKey,
        options: mergedOptions,
      });

      if (result.error) {
        return errorResult(result.error, result.data, result);
      }

      const jobId = result.data?.jobId;

      // The job runs on Summer's servers; the agent polls summer_check_job.
      if (!wait || !jobId) {
        return successResult(jobId ? { ...result.data, next: checkJobNext(jobId) } : result.data);
      }

      // wait=true: block until done
      const pollResult = await pollJob(jobId);

      if (pollResult.error) {
        return errorResult(pollResult.error, { ...pollResult.data, jobId }, pollResult);
      }

      return successResult({
        ...pollResult.data,
        jobId,
        message: "3D generation complete.",
      });
    }
  );

  // ========================================================================
  // summer_generate_video
  // ========================================================================
  server.tool(
    "summer_generate_video",
    `Generate a video using AI models via Summer Engine Studio.

Known models (text-to-video):
  - "ltx" (default) — LTX Video, fast
  - "kling" — Kling 2 Master, high quality
  - "kling-turbo" — Kling 2.5 Turbo Pro
  - "minimax" — MiniMax
  - "veo3" — Google Veo 3, premium

Known models (image-to-video, when imageUrl provided):
  - "ltx" (default), "kling", "minimax"

If imageUrl is provided, switches to image-to-video mode.
Pass provider-specific params in 'options' (negative_prompt, num_frames, etc.).

Returns the generated video URL and asset metadata.
Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    {
      prompt: z
        .string()
        .describe("Description of the video content"),
      model: z
        .string()
        .default("ltx")
        .describe("Model name: ltx, kling, kling-turbo, minimax, veo3 (or any new model)"),
      imageUrl: z
        .string()
        .optional()
        .describe("Source image URL — if provided, uses image-to-video mode"),
      duration: z
        .number()
        .default(5)
        .describe("Duration in seconds (5 or 10)"),
      aspectRatio: z
        .string()
        .default("16:9")
        .describe("Aspect ratio: 16:9, 9:16, 1:1, 4:3"),
      options: z
        .record(z.any())
        .optional()
        .describe("Provider-specific params (negative_prompt, num_frames, guidance_scale, etc.)"),
    },
    async ({ prompt, model, imageUrl, duration, aspectRatio, options }) => {
      const result = await mcpGenerate("/api/mcp/generate/video", {
        prompt,
        model,
        imageUrl,
        duration,
        aspectRatio,
        options,
      });

      if (result.error) {
        return errorResult(result.error, result.data, result);
      }

      return successResult(result.data);
    }
  );

  // ========================================================================
  // summer_check_job
  // ========================================================================
  server.tool(
    "summer_check_job",
    `Check the status of an async generation job.

summer_generate_3d and summer_generate_motion return a jobId; call this with it
every 15-30 seconds until status is "completed" or "failed". A completed job
carries the result: assetId (3D), rigAssetId (rig=true), animationAssetId or
result.assets (motion), with file URLs. Import with summer_import_asset_by_id.

Status values: waiting, active, completed, failed, delayed, unknown.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    {
      jobId: z.string().describe("The job ID returned by an async generation tool"),
    },
    async ({ jobId }) => {
      const token = await getAuthToken();
      if (!token) {
        return errorResult(NOT_SIGNED_IN, undefined, { code: "not_signed_in" });
      }

      let res: Response;
      try {
        const gatewayUrl = await resolveGatewayUrl();
        res = await fetch(`${gatewayUrl}/api/mcp/jobs/${encodeURIComponent(jobId)}`, {
          headers: { ...summerRequestHeaders({ surface: "mcp" }), Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        return errorResult(`Job status check failed: ${describeNetworkError(err)}`, networkDetails(err), { code: "unavailable" });
      }

      const data = await readLenientJson(res);
      if (!res.ok) {
        return errorResult(data.message || data.error || "Failed to check job status", data, statusFailure(res.status));
      }
      return successResult(data);
    }
  );

  // ========================================================================
  // summer_generate_motion
  //
  // Backends exposed: "meshy-library" (curated humanoid mocap by name) and
  // "text-to-motion" (Summer-hosted model, any of the caller's own rigs, from
  // text prompts; default-off on the server until enabled, which answers 400
  // backend_unavailable). The Studio route's "hunyuan-custom" stays hidden: it
  // returns a generic skeleton FBX that is not retargeted onto the caller's
  // rig. The shared zod shape + body builder live in
  // core/capabilities/motion-generation.ts so `summer tool generate-motion`
  // validates identically.
  // ========================================================================
  server.tool(
    "summer_generate_motion",
    `Generate animation clips for a rigged 3D model via Summer Engine Studio.

Backends (pick one):
  - "meshy-library" (default) — a curated mocap clip by motionName on a
    Summer-rigged humanoid (rigAssetId from summer_generate_3d with
    options.rig=true). Fast (~30s), real mocap quality.
    Names that always work: idle, walk, run, jump, attack; anything else must
    be an exact library name.
  - "text-to-motion" — custom 2-second clips (60 frames) from text prompts on
    ANY of your own rigged models: humanoid, animal, creature, cartoon plant,
    prop (GLB/FBX 3d_model, one skinned armature, 5-70 bones). Use it for
    actions the library lacks (nod, bow, shrug, wave with the right arm) and
    for non-humanoid rigs. Pass prompt or prompts (1-8), optional takes (1-4),
    cfgScale (1.5-8, default 3; 5 for clearer gestures), and lockJoints for
    rooted characters (e.g. ["Hips","Spine"] on a plant; never on characters
    that walk). Human-style bone names (Hips, Spine, LeftArm...) animate far
    better, even on non-humans. Jobs take ~1-2 min; result.assets lists one
    animation asset per prompt x take.

Each clip (meshy: each motion; text-to-motion: each prompt x take) is billed.
State the clip list and estimated cost and confirm with the user before
spending.

Returns a jobId within seconds. Poll summer_check_job with it until status is
"completed" (wait=true blocks up to 10 minutes instead). Import finished clips
with summer_import_asset_by_id.

Errors: backend_unavailable means text-to-motion is not enabled on this server
yet — use meshy-library for humanoids and do not retry. Job failures starting
"text_motion:" (no skinned armature, too many/few joints, unknown joint) are
input problems and are refunded; fix the rig or request instead of retrying.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    motionGenerationArgsSchema.shape,
    async (args) => {
      // Client-side validation of the backend-specific rules.
      const built = buildMotionRequestBody(args);
      if ("error" in built) {
        return errorResult(built.error);
      }

      const result = await mcpGenerate("/api/mcp/generate/motion", built.body);

      if (result.error) {
        const hint = motionErrorHint(result.data?.error);
        return errorResult(result.error, hint ? { ...result.data, hint } : result.data, result);
      }

      const jobId = result.data?.jobId;

      if (!args.wait || !jobId) {
        return successResult(jobId ? { ...result.data, next: checkJobNext(jobId) } : result.data);
      }

      const pollResult = await pollJob(jobId);

      if (pollResult.error) {
        const hint = motionJobFailureHint(pollResult.error);
        return errorResult(pollResult.error, { ...pollResult.data, jobId, ...(hint ? { hint } : {}) }, pollResult);
      }

      return successResult({
        ...pollResult.data,
        jobId,
        message:
          args.backend === "text-to-motion"
            ? "Motion generation complete. result.assets lists one animation asset per prompt x take; import with summer_import_asset_by_id."
            : "Motion generation complete. animationAssetId is in result.",
      });
    }
  );
}
