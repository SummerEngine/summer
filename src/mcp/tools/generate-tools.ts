import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getAuthToken } from "../../lib/auth.js";

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require("../../../package.json");

const GATEWAY_URL =
  process.env.SUMMER_GATEWAY_URL || "https://www.summerengine.com";

const TOOL_BY_ENDPOINT: Record<string, string> = {
  "/api/mcp/generate/image": "summer_generate_image",
  "/api/mcp/generate/audio": "summer_generate_audio",
  "/api/mcp/generate/3d": "summer_generate_3d",
  "/api/mcp/generate/video": "summer_generate_video",
  "/api/mcp/generate/motion": "summer_generate_motion",
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

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

async function readJsonResponse(res: Response): Promise<any> {
  if (typeof res.text !== "function") {
    if (typeof res.json === "function") {
      return res.json().catch(() => ({}));
    }
    return {};
  }

  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 1000) };
  }
}

async function mcpGenerate(
  endpoint: string,
  body: Record<string, any>,
  timeoutMs = 120_000
): Promise<{ data?: any; error?: string; status: number }> {
  const idempotencyKey = stringFrom(body.idempotencyKey) ?? randomUUID();
  const requestBody = { ...body, idempotencyKey };
  const withReceipt = (value: unknown, status?: number) => ({
    ...(asRecord(value) ?? {}),
    idempotencyKey,
    ...(status === undefined ? {} : { status }),
  });

  const token = await getAuthToken();
  if (!token) {
    return {
      error:
        "Not signed in. Run in your terminal:\n  npx summer-engine login\nOr open: https://www.summerengine.com/login",
      data: withReceipt({}, 401),
      status: 401,
    };
  }

  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Summer-Client": "summer-cli",
        "X-Summer-Client-Version": CLI_VERSION,
        "X-Summer-Client-Surface": "mcp",
        "X-Summer-MCP-Endpoint": endpoint,
        "X-Summer-MCP-Tool": TOOL_BY_ENDPOINT[endpoint] ?? "unknown",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: `Generation request failed: ${msg}`,
      data: withReceipt({}, 0),
      status: 0,
    };
  }

  const data = await readJsonResponse(res);
  if (!res.ok) {
    const record = asRecord(data);
    if (
      res.status === 409 &&
      record?.error === "needs_animation_selection" &&
      asRecord(record.resume)
    ) {
      const { error: continuationCode, ...continuationData } = record;
      return {
        data: withReceipt(
          {
            ...continuationData,
            status: "needs_user_input",
            code: continuationCode,
          }
        ),
        status: res.status,
      };
    }

    let message = formattedApiErrorMessage(res.status, data);

    if (res.status === 402) {
      message =
        (data.message || "Insufficient credits.") +
        "\nTop up at: https://www.summerengine.com/dashboard\nOr upgrade your plan at: https://www.summerengine.com/pricing";
    }
    if (res.status === 401) {
      message =
        (data.message || "Auth token expired.") +
        "\nRe-authenticate:\n  npx summer-engine login";
    }

    return {
      error: message,
      data: withReceipt(data, res.status),
      status: res.status,
    };
  }
  return { data: withReceipt(data), status: res.status };
}

/**
 * Download an image URL to a temp file so the AI can Read it and show the user.
 */
async function downloadToTemp(
  url: string,
  prefix: string,
  ext = "png"
): Promise<string | null> {
  try {
    const dir = join(tmpdir(), "summer-gen");
    await mkdir(dir, { recursive: true });
    const filename = `${prefix}-${Date.now()}.${ext}`;
    const filepath = join(dir, filename);

    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(filepath, buffer);
    return filepath;
  } catch {
    return null;
  }
}

/**
 * Poll a job until completed, failed, or timeout.
 * Returns the final job status object.
 */
async function pollJob(
  jobId: string,
  maxWaitMs = 300_000,
  intervalMs = 5_000
): Promise<{ data?: any; error?: string }> {
  const token = await getAuthToken();
  if (!token) return { error: "Not signed in" };

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${GATEWAY_URL}/api/mcp/jobs/${encodeURIComponent(jobId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        }
      );

      const data = await res.json();
      if (!res.ok) return { error: data.message || "Poll failed", data };

      if (data.status === "completed") return { data };
      if (data.status === "failed") return { error: data.error || "Job failed", data };

      // Still running — wait and retry
      await new Promise((r) => setTimeout(r, intervalMs));

      // Back off slightly after 30s
      if (Date.now() - (deadline - maxWaitMs) > 30_000) {
        intervalMs = Math.min(intervalMs * 1.2, 15_000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Poll error: ${msg}` };
    }
  }

  return { error: `Timed out after ${maxWaitMs / 1000}s. Use summer_check_job({ jobId: "${jobId}" }) to check later.` };
}

function errorResult(message: string, extra?: Record<string, any>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: true, ...extra, message }, null, 2),
      },
    ],
    isError: true,
  };
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

function sameInputValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeGenerate3DRequest(args: {
  prompt?: string;
  kind?: string;
  model?: string;
  imageUrl?: string;
  title?: string;
  rig?: boolean;
  animationNames?: string[];
  actionIds?: number[];
  targetHeightMeters?: number;
  options?: Record<string, any>;
  idempotencyKey?: string;
}):
  | {
      body: Record<string, any>;
      isAnimatedCharacter: boolean;
    }
  | { error: string } {
  const kind = args.kind ?? "text-to-3d";
  const model = args.model ?? "hunyuan";
  if (kind !== "text-to-3d" && kind !== "image-to-3d") {
    return {
      error:
        'kind must be "text-to-3d" or "image-to-3d". Retexture is not available through summer_generate_3d.',
    };
  }

  const options = args.options ? { ...args.options } : {};
  const mergeExplicit = (
    field: "rig" | "animationNames" | "actionIds",
    explicitValue: unknown
  ): string | undefined => {
    const legacyValue = options[field];
    if (
      explicitValue !== undefined &&
      legacyValue !== undefined &&
      !sameInputValue(explicitValue, legacyValue)
    ) {
      return `Conflicting values for ${field} and options.${field}. Use the top-level ${field} field.`;
    }
    if (explicitValue !== undefined) options[field] = explicitValue;
    return undefined;
  };

  for (const [field, value] of [
    ["rig", args.rig],
    ["animationNames", args.animationNames],
    ["actionIds", args.actionIds],
  ] as const) {
    const error = mergeExplicit(field, value);
    if (error) return { error };
  }

  const legacyHeight =
    options.riggingHeightMeters ?? options.rigging_height_meters;
  if (
    args.targetHeightMeters !== undefined &&
    legacyHeight !== undefined &&
    !sameInputValue(args.targetHeightMeters, legacyHeight)
  ) {
    return {
      error:
        "Conflicting values for targetHeightMeters and options.riggingHeightMeters. Use the top-level targetHeightMeters field.",
    };
  }
  if (args.targetHeightMeters !== undefined) {
    options.riggingHeightMeters = args.targetHeightMeters;
    delete options.rigging_height_meters;
  }

  return {
    body: {
      prompt: args.prompt,
      kind,
      model,
      imageUrl: args.imageUrl,
      title: args.title,
      options: Object.keys(options).length > 0 ? options : undefined,
      idempotencyKey: args.idempotencyKey,
    },
    isAnimatedCharacter:
      options.rig === true &&
      ((Array.isArray(options.animationNames) &&
        options.animationNames.length > 0) ||
        (Array.isArray(options.actionIds) && options.actionIds.length > 0)),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGenerateTools(server: McpServer): void {
  // ========================================================================
  // summer_generate_image
  // ========================================================================
  server.tool(
    "summer_generate_image",
    `Generate an image using AI models via Summer Engine Studio.

Known models:
  - "nano-banana-2" (default) — High quality, supports txt2img and img2img
  - "gemini-flash" — Google Gemini 2.5 Flash, fast
  - "flux-2" — FLUX.2, good for specific styles
  - Any fal-ai model ID works as a passthrough

Two modes:
  - txt2img (default): just pass prompt
  - img2img (edit): pass prompt + referenceImageUrl to edit/transform an existing image

Style presets: "realistic" (default), "cartoon", "anime", "none"

The 'options' object is passed directly to the AI provider for full control.

Returns the asset with fileUrl (hosted) and localPath (temp file on disk).
Use the Read tool on localPath to show the image to the user for approval.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx summer-engine login' first.`,
    {
      prompt: z.string().describe("Description of the image to generate"),
      model: z
        .string()
        .default("nano-banana-2")
        .describe("Model name or full provider ID"),
      style: z
        .string()
        .default("realistic")
        .describe("Style preset: realistic, cartoon, anime, or 'none' to skip"),
      referenceImageUrl: z
        .string()
        .optional()
        .describe("Source image URL for img2img / edit mode. The prompt describes how to transform this image."),
      options: z
        .record(z.any())
        .optional()
        .describe("Provider-specific params (guidance_scale, seed, image_size, negative_prompt, etc.)"),
      idempotencyKey: z
        .string()
        .optional()
        .describe("Stable key for this user intent. Omit on the first call; reuse the returned key for retries or continuation."),
    },
    async ({ prompt, model, style, referenceImageUrl, options, idempotencyKey }) => {
      const result = await mcpGenerate("/api/mcp/generate/image", {
        prompt,
        model,
        style,
        referenceImageUrl,
        options,
        idempotencyKey,
      });

      if (result.error) {
        return errorResult(result.error, result.data);
      }

      // Download to temp so the AI can Read and show the image
      const imageUrl =
        result.data?.asset?.fileUrl || result.data?.asset?.thumbnailUrl;
      let localPath: string | null = null;
      if (imageUrl) {
        localPath = await downloadToTemp(imageUrl, "img");
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
  // summer_generate_audio
  // ========================================================================
  server.tool(
    "summer_generate_audio",
    `Generate audio using AI providers via Summer Engine Studio.

Capabilities:
  - "text_to_speech" — Convert text to spoken audio. Requires 'text'. Optional 'voiceId'.
  - "sound_effects" — Generate sound effects from description. Requires 'text'. Optional 'durationSeconds'.
  - "music" — Generate background music. Requires 'prompt'. Optional 'durationSeconds'.
  - "text_to_dialogue" — Multi-voice dialogue. Requires 'inputs' array of {text, voiceId} objects.

The 'options' object is passed directly to ElevenLabs, so you can set any
provider-specific parameter: stability, similarity_boost, style, speed, etc.

Returns the generated audio URL and asset metadata.
Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx summer-engine login' first.`,
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
        .describe("ElevenLabs model ID (e.g. 'eleven_multilingual_v2')"),
      durationSeconds: z
        .number()
        .optional()
        .describe("Duration in seconds for SFX or music"),
      inputs: z
        .array(z.object({ text: z.string(), voiceId: z.string() }))
        .optional()
        .describe("Dialogue lines for text_to_dialogue"),
      options: z
        .record(z.any())
        .optional()
        .describe("Provider-specific params (stability, similarity_boost, style, speed, etc.)"),
      idempotencyKey: z
        .string()
        .optional()
        .describe("Stable key for this user intent. Omit on the first call; reuse the returned key for retries or continuation."),
    },
    async ({ capability, text, prompt, voiceId, modelId, durationSeconds, inputs, options, idempotencyKey }) => {
      const body: Record<string, any> = { capability };
      if (text) body.text = text;
      if (prompt) body.prompt = prompt;
      if (voiceId) body.voiceId = voiceId;
      if (modelId) body.modelId = modelId;
      if (durationSeconds) body.durationSeconds = durationSeconds;
      if (inputs) body.inputs = inputs;
      if (options) body.options = options;
      if (idempotencyKey) body.idempotencyKey = idempotencyKey;

      const result = await mcpGenerate("/api/mcp/generate/audio", body);

      if (result.error) {
        return errorResult(result.error, result.data);
      }

      return successResult(result.data);
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
  - Any fal-ai model ID works as a passthrough

Available kinds:
  - "text-to-3d" (default) — From text description. Requires 'prompt'.
    Internally generates a 3D-optimized reference image first, then converts to 3D.
  - "image-to-3d" — From your own image. Requires 'imageUrl'.

Humanoid character generation (text or image):
  Set rig=true and provide animationNames or actionIds. Use title as the
  character name and targetHeightMeters for rig scale. Multiple animations
  are submitted together through the shared Meshy character pipeline.

If an animation name is ambiguous, the tool returns status="needs_user_input",
a plain-text question, candidate data, and resume.request as normal MCP content.
Ask the question in ordinary text, show candidates as ordinary text, accept the
user's name or number, append the exact actionId at the supplied path, and retry
resume.request unchanged with the same idempotencyKey. There is no menu, card,
or separate request-user-input tool.

Legacy options.rig/options.animationNames/options.actionIds remain accepted for
compatibility, but new callers should use the typed top-level fields.

Example:
  summer_generate_3d({
    kind: "image-to-3d",
    imageUrl: "https://...",
    title: "Knight",
    rig: true,
    animationNames: ["Idle", "Walk", "Run"]
  })
  // Returns a jobId immediately for the animated-character pipeline.

By default, regular 3D jobs wait for completion (up to 5 min). Animated-character
jobs return jobId immediately because they commonly exceed that budget. Set
wait=true to explicitly wait, or wait=false to always return immediately.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx summer-engine login' first.`,
    {
      prompt: z
        .string()
        .optional()
        .describe("Description of the 3D model, e.g. 'a low-poly treasure chest'"),
      kind: z
        .enum(["text-to-3d", "image-to-3d"])
        .default("text-to-3d")
        .describe("Generation type: text-to-3d or image-to-3d"),
      model: z
        .string()
        .default("hunyuan")
        .describe("Model: hunyuan (default), trellis, meshy, or any fal-ai model ID"),
      imageUrl: z
        .string()
        .optional()
        .describe("Source image URL for image-to-3d"),
      title: z
        .string()
        .optional()
        .describe("Character name/title stored with a humanoid generation."),
      rig: z
        .boolean()
        .optional()
        .describe("Enable the shared Meshy humanoid rig pipeline."),
      animationNames: z
        .array(z.string())
        .optional()
        .describe("Curated animation names to generate together for a humanoid."),
      actionIds: z
        .array(z.number().int().min(0).max(696))
        .optional()
        .describe("Exact Meshy action IDs, including IDs selected during text continuation."),
      targetHeightMeters: z
        .number()
        .positive()
        .max(10)
        .optional()
        .describe("Target humanoid rig height in meters."),
      wait: z
        .boolean()
        .optional()
        .describe("Wait for completion. Defaults to false for animated characters and true for regular 3D jobs."),
      options: z
        .record(z.any())
        .optional()
        .describe("Provider-specific params. options.rig/animationNames/actionIds are deprecated; use top-level fields."),
      idempotencyKey: z
        .string()
        .optional()
        .describe("Stable key for this user intent. Omit on the first call; reuse the returned key for retries or continuation."),
    },
    async ({
      prompt,
      kind,
      model,
      imageUrl,
      title,
      rig,
      animationNames,
      actionIds,
      targetHeightMeters,
      wait,
      options,
      idempotencyKey,
    }) => {
      const normalized = normalizeGenerate3DRequest({
        prompt,
        kind,
        model,
        imageUrl,
        title,
        rig,
        animationNames,
        actionIds,
        targetHeightMeters,
        options,
        idempotencyKey,
      });
      if ("error" in normalized) {
        return errorResult(normalized.error);
      }

      const result = await mcpGenerate(
        "/api/mcp/generate/3d",
        normalized.body
      );

      if (result.error) {
        return errorResult(result.error, result.data);
      }

      const jobId = result.data?.jobId;
      const shouldWait = wait ?? !normalized.isAnimatedCharacter;

      // If not waiting or no jobId, return immediately
      if (!shouldWait || !jobId) {
        return successResult(result.data);
      }

      // Auto-poll until done
      const pollResult = await pollJob(jobId);

      if (pollResult.error) {
        return errorResult(pollResult.error, {
          ...pollResult.data,
          jobId,
          idempotencyKey: result.data.idempotencyKey,
        });
      }

      return successResult({
        ...pollResult.data,
        jobId,
        idempotencyKey: result.data.idempotencyKey,
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
  - "ltx" (default) — LTX Video, fast (~$0.10)
  - "kling" — Kling 2 Master, high quality (~$0.50)
  - "kling-turbo" — Kling 2.5 Turbo Pro (~$0.30)
  - "minimax" — MiniMax (~$0.25)
  - "veo3" — Google Veo 3, premium (~$1.00)

Known models (image-to-video, when imageUrl provided):
  - "ltx" (default), "kling", "minimax"

If imageUrl is provided, switches to image-to-video mode.
Pass provider-specific params in 'options' (negative_prompt, num_frames, etc.).

Returns the generated video URL and asset metadata.
Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx summer-engine login' first.`,
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
      idempotencyKey: z
        .string()
        .optional()
        .describe("Stable key for this user intent. Omit on the first call; reuse the returned key for retries or continuation."),
    },
    async ({ prompt, model, imageUrl, duration, aspectRatio, options, idempotencyKey }) => {
      const result = await mcpGenerate("/api/mcp/generate/video", {
        prompt,
        model,
        imageUrl,
        duration,
        aspectRatio,
        options,
        idempotencyKey,
      });

      if (result.error) {
        return errorResult(result.error, result.data);
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

Use this when you called summer_generate_3d with wait=false, or need to re-check
a job that timed out. Most of the time you won't need this — summer_generate_3d
waits automatically.

Status values: waiting, active, completed, failed, delayed, unknown.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx summer-engine login' first.`,
    {
      jobId: z.string().describe("The job ID returned by an async generation tool"),
    },
    async ({ jobId }) => {
      const token = await getAuthToken();
      if (!token) {
        return errorResult(
          "Not signed in. Run: npx summer-engine login"
        );
      }

      try {
        const res = await fetch(`${GATEWAY_URL}/api/mcp/jobs/${encodeURIComponent(jobId)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });

        const data = await res.json();

        if (!res.ok) {
          return errorResult(data.message || data.error || "Failed to check job status", data);
        }

        return successResult(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Job status check failed: ${msg}`);
      }
    }
  );

  // ========================================================================
  // summer_generate_motion
  //
  // NOTE (2026-05-10): only the "meshy-library" backend is exposed today.
  // The "hunyuan-custom" path exists in the Studio route but has not been
  // tested end-to-end on a user's rig (Hunyuan returns a generic skeleton
  // FBX that isn't retargeted onto the caller's character). The schema and
  // call are kept commented-out below — re-enable by restoring the wider
  // zod enum, the prompt/durationSeconds params, the validation branch, and
  // the relevant description lines once the path is verified.
  // ========================================================================
  server.tool(
    "summer_generate_motion",
    `Generate an animation clip for a Meshy-rigged humanoid character via Summer Engine Studio.

Backend:
  - "meshy-library" — picks a clip from a curated mocap set by name (idle, walk,
    run, attack_sword, jump, ~70 standard names). Fast (~30s), cheap (~$0.10),
    real mocap quality.

Requires a Meshy-rigged humanoid as the target. The 'rigAssetId' must come from
a prior summer_generate_3d call with options.rig=true.

By default, one motion waits for completion (up to 5 min). Multi-motion requests
return jobId immediately. Set wait=true to explicitly wait, or wait=false to
always return immediately.

Common motion names:
  Locomotion: idle, idle_alert, idle_combat, walk, walk_back, run, sprint,
              crouch_idle, crouch_walk, jump, jump_loop, jump_land
  Combat: attack_sword, attack_punch, attack_kick, attack_bow, attack_cast,
          block, dodge_left, dodge_right, hit_react, death
  Social: wave, dance, sit_idle

Cost: ~$0.10 per clip. Confirm with user before spending.

Custom prompt-driven motion is on the roadmap; not yet shipped. For one-off
signature moves not on the curated list, fall back to hand-authoring in the
Godot editor or importing from Mixamo.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx summer-engine login' first.`,
    {
      rigAssetId: z
        .string()
        .describe("Asset ID of a rigged character (from summer_generate_3d with options.rig=true)"),
      backend: z
        .enum(["meshy-library"])
        .default("meshy-library")
        .describe("Backend: meshy-library (only option today)"),
      motionName: z
        .string()
        .optional()
        .describe("One curated motion name: walk, run, attack_sword, idle, jump, etc."),
      motionNames: z
        .array(z.string())
        .optional()
        .describe("Multiple curated motion names to add in one request."),
      actionIds: z
        .array(z.number().int())
        .optional()
        .describe("Resolved Meshy action IDs, including IDs selected after a needs_user_input response."),
      // prompt + durationSeconds reserved for the hunyuan-custom backend (not
      // shipped yet — see header comment).
      wait: z
        .boolean()
        .optional()
        .describe("Wait for completion. Defaults to false for multi-motion requests and true for one motion."),
      options: z
        .record(z.any())
        .optional()
        .describe("Backend-specific passthrough"),
      idempotencyKey: z
        .string()
        .optional()
        .describe("Stable key for this user intent. Omit on the first call; reuse the returned key for retries or continuation."),
    },
    async ({ rigAssetId, backend, motionName, motionNames, actionIds, wait, options, idempotencyKey }) => {
      // Client-side validation
      if (!motionName && !motionNames?.length && !actionIds?.length) {
        return errorResult(
          "Provide motionName, motionNames, or actionIds. See the tool description for the curated list."
        );
      }

      const normalizedMotionNames =
        motionNames?.length ? motionNames : motionName ? [motionName] : undefined;
      const body = {
        rigAssetId,
        backend,
        motionNames: normalizedMotionNames,
        actionIds,
        options,
        idempotencyKey,
      };

      const result = await mcpGenerate("/api/mcp/generate/motion", body);

      if (result.error) {
        return errorResult(result.error, result.data);
      }

      const jobId = result.data?.jobId;
      const requestedMotionCount =
        (normalizedMotionNames?.length ?? 0) + (actionIds?.length ?? 0);
      const shouldWait = wait ?? requestedMotionCount <= 1;

      if (!shouldWait || !jobId) {
        return successResult(result.data);
      }

      const pollResult = await pollJob(jobId);

      if (pollResult.error) {
        return errorResult(pollResult.error, {
          ...pollResult.data,
          jobId,
          idempotencyKey: result.data.idempotencyKey,
        });
      }

      return successResult({
        ...pollResult.data,
        jobId,
        idempotencyKey: result.data.idempotencyKey,
        message: "Motion generation complete. animationAssetId is in result.",
      });
    }
  );
}
