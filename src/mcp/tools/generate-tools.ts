import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getAuthToken } from "../../core/auth.js";
import { resolveGatewayUrl } from "../../core/config.js";
import { readJsonResponse } from "../../core/util/http.js";
import { asRecord, stringFrom } from "../../core/util/json.js";
import { TOOLKIT_VERSION as CLI_VERSION } from "../../core/version.js";

const TOOL_BY_ENDPOINT: Record<string, string> = {
  "/api/mcp/generate/image": "summer_generate_image",
  "/api/mcp/generate/audio": "summer_generate_audio",
  "/api/mcp/generate/3d": "summer_generate_3d",
  "/api/mcp/generate/video": "summer_generate_video",
  "/api/mcp/generate/motion": "summer_generate_motion",
  "/api/mcp/generate/slice-asset-sheet": "summer_slice_asset_sheet",
  "/api/mcp/workflows": "summer_get_studio_workflow",
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

async function mcpGenerate(
  endpoint: string,
  body: Record<string, any>,
  timeoutMs = 120_000
): Promise<{ data?: any; error?: string; status: number }> {
  const token = await getAuthToken();
  if (!token) {
    return {
      error:
        "Not signed in. Run in your terminal:\n  npx -y summer-engine@latest login\nOr open: https://www.summerengine.com/login",
      status: 401,
    };
  }

  const gatewayUrl = await resolveGatewayUrl();
  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}${endpoint}`, {
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
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Generation request failed: ${msg}`, status: 0 };
  }

  const data = await readLenientJson(res);
  if (!res.ok) {
    let message = formattedApiErrorMessage(res.status, data);

    if (res.status === 402) {
      message =
        (data.message || "Insufficient credits.") +
        "\nTop up at: https://www.summerengine.com/dashboard\nOr upgrade your plan at: https://www.summerengine.com/pricing";
    }
    if (res.status === 401) {
      message =
        (data.message || "Auth token expired.") +
        "\nRe-authenticate:\n  npx -y summer-engine@latest login";
    }

    return { error: message, data: { ...data, status: res.status }, status: res.status };
  }
  return { data, status: res.status };
}

async function mcpGet(
  endpoint: string,
  searchParams?: URLSearchParams,
  timeoutMs = 30_000
): Promise<{ data?: any; error?: string; status: number }> {
  const token = await getAuthToken();
  const suffix = searchParams?.size ? `?${searchParams.toString()}` : "";
  const gatewayUrl = await resolveGatewayUrl();
  let res: Response;
  try {
    res = await fetch(`${gatewayUrl}${endpoint}${suffix}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-Summer-Client": "summer-cli",
        "X-Summer-Client-Version": CLI_VERSION,
        "X-Summer-Client-Surface": "mcp",
        "X-Summer-MCP-Endpoint": endpoint,
        "X-Summer-MCP-Tool": TOOL_BY_ENDPOINT[endpoint] ?? "unknown",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Request failed: ${msg}`, status: 0 };
  }

  const data = await readLenientJson(res);
  if (!res.ok) {
    return {
      error: formattedApiErrorMessage(res.status, data),
      data: { ...data, status: res.status },
      status: res.status,
    };
  }
  return { data, status: res.status };
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
  maxWaitMs = 600_000,
  intervalMs = 5_000
): Promise<{ data?: any; error?: string }> {
  const token = await getAuthToken();
  if (!token) return { error: "Not signed in" };

  const gatewayUrl = await resolveGatewayUrl();
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${gatewayUrl}/api/mcp/jobs/${encodeURIComponent(jobId)}`,
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
      if (result.error) return errorResult(result.error, result.data);
      return successResult(result.data);
    }
  );

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

Model ids are an ALLOWLIST, not a passthrough. An unrecognised id is rejected
with 400 and the response lists every accepted id — it is not silently swapped.

Two modes:
  - txt2img (default): just pass prompt
  - img2img (edit): pass prompt + referenceImageUrl to edit/transform an existing image

Style presets: "realistic" (default), "cartoon", "anime", "none"

The 'options' object is passed directly to the AI provider for full control.

Returns the asset with fileUrl (hosted) and localPath (temp file on disk).
Use the Read tool on localPath to show the image to the user for approval.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
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
    },
    async ({ prompt, model, style, referenceImageUrl, options }) => {
      const result = await mcpGenerate("/api/mcp/generate/image", {
        prompt,
        model,
        style,
        referenceImageUrl,
        options,
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
        return errorResult(result.error, result.data);
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
  - "sound_effects" — Generate sound effects from description. Requires 'text'. Optional 'durationSeconds'.
  - "music" — Generate background music. Requires 'prompt'. Optional 'durationSeconds'.
  - "text_to_dialogue" — Multi-voice dialogue. Requires 'inputs' array of {text, voiceId} objects.

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
        .describe(
          "Provider params, spread at the SDK's top level. Voice tuning goes in " +
          "options.voiceSettings with camelCase keys (stability, similarityBoost, " +
          "style, speed, useSpeakerBoost); flat snake_case is silently ignored."
        ),
    },
    async ({ capability, text, prompt, voiceId, modelId, durationSeconds, inputs, options }) => {
      const body: Record<string, any> = { capability };
      if (text) body.text = text;
      if (prompt) body.prompt = prompt;
      if (voiceId) body.voiceId = voiceId;
      if (modelId) body.modelId = modelId;
      if (durationSeconds) body.durationSeconds = durationSeconds;
      if (inputs) body.inputs = inputs;
      if (options) body.options = options;

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
  add animation clips. Adds ~$0.30 and ~60s to the job.

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

By default, waits for completion (up to 10 min) and returns the result directly.
Set wait=false to get the jobId immediately and poll manually with summer_check_job.

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
        .default(true)
        .describe("Wait for completion (default true, up to 10 min). Set false to get jobId immediately."),
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
        return errorResult(result.error, result.data);
      }

      const jobId = result.data?.jobId;

      // If not waiting or no jobId, return immediately
      if (!wait || !jobId) {
        return successResult(result.data);
      }

      // Auto-poll until done
      const pollResult = await pollJob(jobId);

      if (pollResult.error) {
        return errorResult(pollResult.error, { ...pollResult.data, jobId });
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
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
    {
      jobId: z.string().describe("The job ID returned by an async generation tool"),
    },
    async ({ jobId }) => {
      const token = await getAuthToken();
      if (!token) {
        return errorResult(
          "Not signed in. Run: npx -y summer-engine@latest login"
        );
      }

      try {
        const gatewayUrl = await resolveGatewayUrl();
        const res = await fetch(`${gatewayUrl}/api/mcp/jobs/${encodeURIComponent(jobId)}`, {
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

By default, waits for completion (up to 5 min) and returns the result directly.
Set wait=false to get the jobId immediately and poll manually with summer_check_job.

Common motion names:
  Locomotion: idle, idle_alert, idle_combat, walk, walk_back, run, sprint,
              crouch_idle, crouch_walk, jump, jump_loop, jump_land
  Combat: attack_sword, attack_punch, attack_kick, attack_bow, attack_cast,
          block, dodge_left, dodge_right, hit_react, death
  Social: wave, dance, sit_idle

Cost: ~$0.10 per clip. Confirm with user before spending.

Custom prompt-driven motion is on the roadmap; not yet shipped. For one-off
signature moves not on the curated list, fall back to hand-authoring in the
Summer Engine or importing from Mixamo.

Cloud tool — runs on Summer's servers and works WITHOUT the Summer Engine app open.
Requires authentication: run 'npx -y summer-engine@latest login' first.`,
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
        .describe("Curated motion name: walk, run, attack_sword, idle, jump, etc."),
      // prompt + durationSeconds reserved for the hunyuan-custom backend (not
      // shipped yet — see header comment).
      wait: z
        .boolean()
        .default(true)
        .describe("Wait for completion (default true, up to 5 min). Set false to get jobId immediately."),
      options: z
        .record(z.any())
        .optional()
        .describe("Backend-specific passthrough"),
    },
    async ({ rigAssetId, backend, motionName, wait, options }) => {
      // Client-side validation
      if (!motionName) {
        return errorResult(
          "motionName is required (e.g. 'walk', 'run', 'attack_sword'). See the tool description for the curated list."
        );
      }

      const body = {
        rigAssetId,
        backend,
        motionName,
        options,
      };

      const result = await mcpGenerate("/api/mcp/generate/motion", body);

      if (result.error) {
        return errorResult(result.error, result.data);
      }

      const jobId = result.data?.jobId;

      if (!wait || !jobId) {
        return successResult(result.data);
      }

      const pollResult = await pollJob(jobId);

      if (pollResult.error) {
        return errorResult(pollResult.error, { ...pollResult.data, jobId });
      }

      return successResult({
        ...pollResult.data,
        jobId,
        message: "Motion generation complete. animationAssetId is in result.",
      });
    }
  );
}
