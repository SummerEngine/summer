import { z } from "zod";

/** Shared MCP/CLI contract for POST /api/mcp/generate/motion.
 *
 *  Two backends are exposed:
 *   - meshy-library: curated mocap clip by name on a Summer-rigged humanoid.
 *   - text-to-motion: Summer-hosted text-to-motion model; animates any of the
 *     caller's own rigged models (5-70 bones) from text prompts.
 *  The Studio route also has "hunyuan-custom"; it stays hidden (it returns a
 *  generic skeleton that is not retargeted onto the caller's rig). */
export const MOTION_BACKENDS = ["meshy-library", "text-to-motion"] as const;
export type MotionBackend = (typeof MOTION_BACKENDS)[number];

const motionPrompt = z.string().min(1).max(300);

export const motionGenerationArgsSchema = z.object({
  rigAssetId: z
    .string()
    .describe(
      "Asset ID of the rigged 3d_model. meshy-library: a Summer-rigged humanoid (summer_generate_3d with options.rig=true). text-to-motion: any of your own rigged GLB/FBX models"
    ),
  backend: z
    .enum(MOTION_BACKENDS)
    .default("meshy-library")
    .describe(
      "meshy-library (default): curated humanoid mocap clip by motionName. text-to-motion: custom clips from text prompts on any of your own rigs (humanoid, animal, creature, plant, prop)"
    ),
  motionName: z
    .string()
    .optional()
    .describe("meshy-library only (required there): curated motion name — idle, walk, run, jump, attack, or an exact library name"),
  prompt: motionPrompt
    .optional()
    .describe("text-to-motion: one action as a verb phrase, e.g. 'waves hello with the right arm' (1-300 chars). Shorthand for prompts: [prompt]"),
  prompts: z
    .array(motionPrompt)
    .min(1)
    .max(8)
    .optional()
    .describe("text-to-motion: 1-8 actions, one clip each (each 1-300 chars)"),
  takes: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("text-to-motion: variations per prompt, 1-4 (default 1). Every take is a billed clip"),
  lockJoints: z
    .array(z.string().min(1))
    .optional()
    .describe("text-to-motion: bone names held still, e.g. ['Hips','Spine'] for a rooted plant. Never on characters that walk or jump"),
  cfgScale: z
    .number()
    .min(1.5)
    .max(8)
    .optional()
    .describe("text-to-motion: prompt adherence 1.5-8 (default 3); 5 for bigger, clearer gestures on stylized rigs"),
  idempotencyKey: z
    .string()
    .optional()
    .describe("Stable retry key so the same logical request is not billed or queued twice"),
  wait: z
    .boolean()
    .default(true)
    .describe("Wait for completion (default true, up to 10 min). Set false to get jobId immediately."),
  options: z
    .record(z.any())
    .optional()
    .describe("Backend-specific passthrough"),
});

export type MotionGenerationArgs = z.input<typeof motionGenerationArgsSchema>;

const TEXT_MOTION_ONLY = ["prompt", "prompts", "takes", "lockJoints", "cfgScale"] as const;

/** Validate the backend-specific rules zod cannot express on a flat shape and
 *  build the request body. Returns an error message instead of throwing so
 *  each face renders it its own way. */
export function buildMotionRequestBody(
  args: MotionGenerationArgs
): { body: Record<string, unknown> } | { error: string } {
  const backend: MotionBackend = args.backend ?? "meshy-library";

  if (backend === "meshy-library") {
    const stray = TEXT_MOTION_ONLY.filter((key) => args[key] !== undefined);
    if (stray.length > 0) {
      return {
        error: `${stray.join(", ")} only apply to backend "text-to-motion". Set backend: "text-to-motion" for prompt-driven clips, or pass motionName for the meshy-library curated clips.`,
      };
    }
    if (!args.motionName) {
      return {
        error:
          "motionName is required for backend \"meshy-library\" (e.g. 'idle', 'walk', 'run', 'jump', 'attack'). For a custom action or a non-humanoid rig use backend: \"text-to-motion\" with prompt/prompts.",
      };
    }
    return {
      body: {
        rigAssetId: args.rigAssetId,
        backend,
        motionName: args.motionName,
        ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
        options: args.options,
      },
    };
  }

  if (args.motionName !== undefined) {
    return {
      error:
        "motionName only applies to backend \"meshy-library\". For text-to-motion describe the action in prompt or prompts (e.g. 'nods happily').",
    };
  }
  if (args.prompt !== undefined && args.prompts !== undefined) {
    return { error: "Pass either prompt or prompts, not both." };
  }
  const prompts = args.prompts ?? (args.prompt !== undefined ? [args.prompt] : []);
  if (prompts.length === 0 || prompts.some((p) => p.trim().length === 0)) {
    return {
      error:
        "prompt_required: backend \"text-to-motion\" needs prompt or prompts (1-8 actions, each 1-300 chars), e.g. prompts: ['waves hello with the right arm', 'nods happily'].",
    };
  }
  return {
    body: {
      rigAssetId: args.rigAssetId,
      backend,
      prompts,
      ...(args.takes !== undefined ? { takes: args.takes } : {}),
      ...(args.lockJoints !== undefined ? { lockJoints: args.lockJoints } : {}),
      ...(args.cfgScale !== undefined ? { cfgScale: args.cfgScale } : {}),
      ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
      ...(args.options ? { options: args.options } : {}),
    },
  };
}

const MOTION_ERROR_HINTS: Record<string, string> = {
  backend_unavailable:
    "text-to-motion is not enabled on this server yet. For humanoid idle/walk/run/jump/attack use backend \"meshy-library\"; do not retry text-to-motion.",
  prompt_required: "Pass prompt or prompts (1-8 actions, each 1-300 chars).",
  invalid_takes: "takes must be an integer 1-4.",
  invalid_cfg_scale: "cfgScale must be a number 1.5-8 (default 3; 5 for clearer gestures).",
  invalid_lock_joints: "lockJoints must be bone names that exist in the rig, e.g. [\"Hips\",\"Spine\"].",
  rig_asset_not_found:
    "rigAssetId must be one of your own 3d_model assets — find it with summer_list_my_assets or summer_search_assets (source my_assets).",
  rig_asset_invalid:
    "The asset must be your own rigged GLB/FBX 3d_model with one skinned armature and 5-70 bones. Rig it first (summer_generate_3d with options.rig=true for humanoids).",
  insufficient_credits: "Not enough credits for every prompt x take. Reduce prompts/takes or top up.",
};

/** Actionable hint for a server error code, if we know one. */
export function motionErrorHint(code: unknown): string | undefined {
  return typeof code === "string" ? MOTION_ERROR_HINTS[code] : undefined;
}

/** Hint for a failed text-to-motion job ("text_motion: ..." failures are input
 *  problems and the charge is refunded). */
export function motionJobFailureHint(message: unknown): string | undefined {
  if (typeof message !== "string" || !message.startsWith("text_motion:")) return undefined;
  return "Input problem with the rig or request; the charge was refunded. Fix the rig (one skinned armature, 5-70 bones) or the request instead of retrying unchanged.";
}
