import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getAuthToken } from "../../lib/auth.js";

const GATEWAY_URL =
  process.env.SUMMER_GATEWAY_URL || "https://www.summerengine.com";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function mcpGenerate(
  endpoint: string,
  body: Record<string, any>,
  timeoutMs = 120_000
): Promise<{ data?: any; error?: string; status: number }> {
  const token = await getAuthToken();
  if (!token) {
    return {
      error:
        "Not signed in. Run in your terminal:\n  npx summer-engine login\nOr open: https://www.summerengine.com/login",
      status: 401,
    };
  }

  const res = await fetch(`${GATEWAY_URL}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const data = await res.json();
  if (!res.ok) {
    let message = data.message || data.error || "Request failed";

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

    return { error: message, data, status: res.status };
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
        text: JSON.stringify({ error: true, message, ...extra }, null, 2),
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
  - Any fal-ai model ID works as a passthrough

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

By default, waits for completion (up to 5 min) and returns the result directly.
Set wait=false to get the jobId immediately and poll manually with summer_check_job.

Requires authentication: run 'npx summer-engine login' first.`,
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
      wait: z
        .boolean()
        .default(true)
        .describe("Wait for completion (default true, up to 5 min). Set false to get jobId immediately."),
      options: z
        .record(z.any())
        .optional()
        .describe("Provider-specific params (target_polycount, topology, art_style, etc.)"),
    },
    async ({ prompt, kind, model, imageUrl, wait, options }) => {
      const result = await mcpGenerate("/api/mcp/generate/3d", {
        prompt,
        kind,
        model,
        imageUrl,
        options,
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
  // ========================================================================
  server.tool(
    "summer_generate_motion",
    `Generate an animation clip for a rigged humanoid character via Summer Engine Studio.

Two backends:
  - "meshy-library" — picks a clip from a curated mocap set by name (idle, walk,
    run, attack_sword, jump, ~70 standard names). Fast (~30s), cheap (~$0.10),
    real mocap quality. Use when the action is on the curated list.
  - "hunyuan-custom" — generates a never-before-seen clip from a text prompt.
    Slower (1-3 min), pricier (~$0.40), non-deterministic. Use when the action
    is specific to this character (e.g. "drops to one knee, draws bow").

Both backends require a Meshy-rigged humanoid as the target. The 'rigAssetId'
must come from a prior summer_generate_3d call with options.rig=true.

By default, waits for completion (up to 5 min) and returns the result directly.
Set wait=false to get the jobId immediately and poll manually with summer_check_job.

Common motion names for meshy-library:
  Locomotion: idle, idle_alert, idle_combat, walk, walk_back, run, sprint,
              crouch_idle, crouch_walk, jump, jump_loop, jump_land
  Combat: attack_sword, attack_punch, attack_kick, attack_bow, attack_cast,
          block, dodge_left, dodge_right, hit_react, death
  Social: wave, dance, sit_idle

Cost: meshy-library ~$0.10, hunyuan-custom ~$0.40. Confirm with user before
spending.

Requires authentication: run 'npx summer-engine login' first.`,
    {
      rigAssetId: z
        .string()
        .describe("Asset ID of a rigged character (from summer_generate_3d with options.rig=true)"),
      backend: z
        .enum(["meshy-library", "hunyuan-custom"])
        .describe("Backend: meshy-library (fast, curated) or hunyuan-custom (slow, prompt-driven)"),
      motionName: z
        .string()
        .optional()
        .describe("Curated motion name (required for meshy-library): walk, run, attack_sword, etc."),
      prompt: z
        .string()
        .optional()
        .describe("Text description of the motion (required for hunyuan-custom)"),
      durationSeconds: z
        .number()
        .optional()
        .default(4)
        .describe("Clip duration for hunyuan-custom (1-10s typical)"),
      wait: z
        .boolean()
        .default(true)
        .describe("Wait for completion (default true, up to 5 min). Set false to get jobId immediately."),
      options: z
        .record(z.any())
        .optional()
        .describe("Backend-specific passthrough"),
    },
    async ({ rigAssetId, backend, motionName, prompt, durationSeconds, wait, options }) => {
      // Client-side validation
      if (backend === "meshy-library" && !motionName) {
        return errorResult(
          "meshy-library backend requires motionName (e.g. 'walk', 'run', 'attack_sword')"
        );
      }
      if (backend === "hunyuan-custom" && !prompt) {
        return errorResult(
          "hunyuan-custom backend requires a prompt describing the motion"
        );
      }

      const body = {
        rigAssetId,
        backend,
        motionName,
        prompt,
        durationSeconds,
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
