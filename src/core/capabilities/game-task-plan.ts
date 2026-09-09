import { z } from "zod";
import { getSkillRegistry, type SkillRegistryEntry } from "../skills-registry.js";

export const GAME_TASK_MODES = [
  "auto",
  "new-game",
  "feature",
  "asset",
  "debug",
  "playtest",
  "polish",
  "ship",
] as const;

export const GAME_TASK_TARGETS = [
  "auto",
  "2d",
  "3d",
  "ui",
  "audio",
  "animation",
  "level",
  "npc",
  "multiplayer",
] as const;

export const ASSET_POLICIES = [
  "reuse-first",
  "ask-before-paid-generation",
  "no-paid-generation",
  "generate-when-clearly-needed",
] as const;

export const VERIFICATION_LEVELS = ["none", "fast", "full"] as const;

/**
 * The one input contract for summer_start_game_task, shared by the MCP tool
 * (pass `.shape` to server.tool) and the CLI dispatcher (`summer tool
 * start-game-task`) so a typo like mode:"shipp" is rejected on both faces.
 */
export const gameTaskPlanInputSchema = z.object({
  goal: z.string().trim().min(1, "goal is required"),
  mode: z.enum(GAME_TASK_MODES).default("auto"),
  target: z.enum(GAME_TASK_TARGETS).default("auto"),
  assetPolicy: z.enum(ASSET_POLICIES).default("ask-before-paid-generation"),
  verification: z.enum(VERIFICATION_LEVELS).default("full"),
});

export type GameTaskMode = (typeof GAME_TASK_MODES)[number];
export type GameTaskTarget = (typeof GAME_TASK_TARGETS)[number];
export type AssetPolicy = (typeof ASSET_POLICIES)[number];
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export interface GameTaskPlanOptions {
  goal: string;
  mode?: GameTaskMode;
  target?: GameTaskTarget;
  assetPolicy?: AssetPolicy;
  verification?: VerificationLevel;
}

export interface SkillRoute {
  /** Library resource id, e.g. "skill/make-game". */
  id: string;
  name: string;
  why: string;
}

export interface GameTaskPlan {
  goal: string;
  mode: Exclude<GameTaskMode, "auto">;
  target: Exclude<GameTaskTarget, "auto"> | "general";
  assetPolicy: AssetPolicy;
  verification: VerificationLevel;
  principles: string[];
  recommendedSkills: SkillRoute[];
  mcpToolPlan: {
    start: string[];
    mutate: string[];
    assets: string[];
    verify: string[];
  };
  hostFileWork: string[];
  userGates: string[];
  nextAgentSteps: string[];
  antiPatterns: string[];
}

type WeightedSkill = { name: string; why: string; weight: number };

let skillIndex: Map<string, SkillRegistryEntry> | null = null;

/**
 * Lazily load the generated skill registry on first use. Loading at module
 * import made a missing or corrupt registry/generated/skills-registry.json
 * crash the whole MCP server / CLI at import time; now only this tool fails,
 * with an actionable message.
 */
function skillByName(): Map<string, SkillRegistryEntry> {
  if (skillIndex) return skillIndex;
  let skills: readonly SkillRegistryEntry[];
  try {
    skills = getSkillRegistry();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      "The Summer skill registry could not be loaded (registry/generated/skills-registry.json): " +
        `${reason}. Reinstall summer-engine, or in a source checkout run 'npm run generate:registry'.`
    );
  }
  skillIndex = new Map(skills.map((skill) => [skill.name, skill]));
  return skillIndex;
}

const PATTERN_CACHE = new Map<string, RegExp>();

/**
 * Whole-word / whole-phrase match with light plural tolerance ("model" also
 * matches "models", "enemy" also matches "enemies"). Substring matching routed
 * "spaceship" to ship mode, "build" to the ui target ("b-ui-ld"), "fortune" to
 * playtest ("tune") and "terror" to debug ("error").
 */
function wordPattern(word: string): RegExp {
  const cached = PATTERN_CACHE.get(word);
  if (cached) return cached;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plural = word.endsWith("y")
    ? `(?:${escaped}|${escaped.slice(0, -1)}ies)`
    : `${escaped}(?:e?s)?`;
  const pattern = new RegExp(`(?<![a-z0-9])${plural}(?![a-z0-9])`, "i");
  PATTERN_CACHE.set(word, pattern);
  return pattern;
}

function includesAny(text: string, words: string[]): boolean {
  return words.some((word) => wordPattern(word).test(text));
}

function inferMode(goal: string, requested: GameTaskMode): Exclude<GameTaskMode, "auto"> {
  if (requested !== "auto") return requested;
  const text = goal.toLowerCase();
  const gameGenre = includesAny(text, [
    "shooter",
    "platformer",
    "roguelike",
    "rpg",
    "racing",
    "puzzle game",
    "survival",
    "tower defense",
    "metroidvania",
    "arena",
  ]);
  const buildVerb = /(^|\s)(make|build|create|start)\s/.test(text);
  if (includesAny(text, ["crash", "bug", "error", "broken", "fix", "debug", "not working"])) return "debug";
  if (includesAny(text, ["export", "ship", "release", "build for", "deploy"])) return "ship";
  if (includesAny(text, ["playtest", "test the game", "feel", "tune"])) return "playtest";
  if (includesAny(text, ["asset", "model", "sprite", "texture", "sound", "music", "voice", "animation"])) return "asset";
  if (includesAny(text, ["new game", "start a game", "make a game", "prototype", "from scratch"]) || (buildVerb && gameGenre)) return "new-game";
  if (includesAny(text, ["polish", "lighting", "performance", "juice", "ui pass"])) return "polish";
  return "feature";
}

function inferTarget(goal: string, requested: GameTaskTarget): GameTaskPlan["target"] {
  if (requested !== "auto") return requested;
  const text = goal.toLowerCase();
  if (includesAny(text, ["3d", "model", "mesh", "glb", "character", "prop", "vehicle", "tree", "rock"])) return "3d";
  if (includesAny(text, ["2d", "sprite", "pixel", "portrait", "icon", "texture", "tileset", "skybox"])) return "2d";
  if (includesAny(text, ["sound", "sfx", "music", "audio", "voice", "dialogue", "ambient"])) return "audio";
  if (includesAny(text, ["animation", "animate", "idle", "walk", "run", "attack", "motion", "retarget"])) return "animation";
  if (includesAny(text, ["ui", "hud", "menu", "button", "inventory"])) return "ui";
  if (includesAny(text, ["level", "map", "dungeon", "arena", "room", "world"])) return "level";
  if (includesAny(text, ["npc", "enemy", "boss", "dialogue", "behavior"])) return "npc";
  if (includesAny(text, ["multiplayer", "network", "server", "host", "peer"])) return "multiplayer";
  return "general";
}

function addSkill(routes: WeightedSkill[], name: string, why: string, weight: number): void {
  if (!skillByName().has(name)) return;
  const existing = routes.find((route) => route.name === name);
  if (existing) {
    if (weight > existing.weight) {
      existing.weight = weight;
      existing.why = why;
    }
    return;
  }
  routes.push({ name, why, weight });
}

function inferSkills(mode: GameTaskPlan["mode"], target: GameTaskPlan["target"], goal: string): SkillRoute[] {
  const text = goal.toLowerCase();
  const routes: WeightedSkill[] = [];
  const animationIntent = includesAny(text, [
    "animated",
    "animation",
    "animate",
    "idle",
    "walk",
    "run",
    "jump",
    "attack",
    "motion",
    "mocap",
    "locomotion",
    "animationtree",
    "state machine",
  ]);
  const assetIntent =
    mode === "asset" ||
    includesAny(text, [
      "asset",
      "model",
      "mesh",
      "glb",
      "sprite",
      "texture",
      "sound",
      "sfx",
      "music",
      "voice",
      "animation clip",
    ]);

  addSkill(routes, "using-summer", "Baseline workflow for building through Summer CLI/MCP.", 100);

  if (mode === "debug") {
    addSkill(routes, "debug", "Primary runtime/script/diagnostics loop.", 300);
    addSkill(routes, "investigating-bugs", "Systematic bug investigation workflow.", 220);
  }

  if (mode === "playtest") {
    addSkill(routes, "play", "Run, observe, and report runtime state.", 260);
    addSkill(routes, "playtesting-a-feature", "Feature-level playtest loop.", 220);
    addSkill(routes, "debugging-game-feel", "Tune feel problems after runtime verification.", 160);
  }

  if (mode === "new-game") {
    addSkill(routes, "new-project", "Create/open the project if needed.", 260);
    addSkill(routes, "brainstorm-game", "Lock a small playable brief before building.", 240);
    addSkill(routes, "make-game", "Build one narrow playable prototype end-to-end.", 300);
  }

  if (mode === "ship") {
    addSkill(routes, "export-and-ship", "Export and release readiness workflow.", 280);
    addSkill(routes, "tune-performance", "Performance pass before shipping.", 180);
  }

  if (mode === "polish") {
    addSkill(routes, "art-direction", "Visual consistency and taste pass.", 200);
    addSkill(routes, "3d-lighting", "Lighting/world environment pass for 3D scenes.", 190);
    addSkill(routes, "game-feel", "Screen shake, hit-stop, juice, and responsiveness.", 180);
    addSkill(routes, "tune-performance", "Frame budget and bottleneck pass.", 170);
  }

  if (assetIntent) {
    addSkill(routes, "asset-strategy", "Choose reuse/import/generate before spending credits.", 260);
  }

  if (target === "3d" && assetIntent) {
    if (includesAny(text, ["character", "player", "npc", "enemy", "boss", "humanoid", "rig"])) {
      addSkill(routes, "character-model", "Humanoid T-pose, mesh, rig, and handoff to animation.", 300);
    } else if (includesAny(text, ["vehicle", "car", "ship", "spaceship", "mech", "tank", "bike"])) {
      addSkill(routes, "vehicle-model", "Hard-surface vehicle generation and scene wiring.", 280);
    } else if (includesAny(text, ["tree", "rock", "mushroom", "foliage", "plant", "crystal"])) {
      addSkill(routes, "organic-model", "Fast organic 3D asset generation and scatter guidance.", 270);
    } else if (includesAny(text, ["kit", "modular", "wall", "floor", "door", "pillar", "dungeon"])) {
      addSkill(routes, "environment-kit", "Style-locked modular kit workflow.", 270);
    } else {
      addSkill(routes, "prop-model", "Single static 3D prop workflow.", 270);
    }
    addSkill(routes, "scene-composition", "Instantiate/import models into robust scene structure.", 150);
    if (animationIntent && includesAny(text, ["character", "player", "npc", "enemy", "boss", "humanoid", "rig"])) {
      addSkill(routes, "generate-motion", "Generate idle/walk/run/jump/attack clips for the rigged character.", 275);
      addSkill(routes, "animation-tree", "Wire generated clips into playback/state-machine behavior.", 210);
    }
  }

  if (target === "3d" && !assetIntent) {
    addSkill(routes, "scene-composition", "Build robust 3D scene structure.", 220);
    addSkill(routes, "3d-lighting", "Give the scene readable camera, light, and environment defaults.", 180);
  }

  if (target === "2d" && assetIntent) {
    if (includesAny(text, ["sprite sheet", "spritesheet", "run cycle", "frame grid"])) {
      addSkill(routes, "sprite-sheet", "Frame grid/sprite animation workflow.", 280);
    } else if (includesAny(text, ["texture", "tile", "seamless", "wall", "floor"])) {
      addSkill(routes, "tileable-texture", "Seamless texture generation and material use.", 260);
    } else if (includesAny(text, ["portrait", "dialogue", "bust"])) {
      addSkill(routes, "character-portrait", "Polished dialogue portrait workflow.", 260);
    } else if (includesAny(text, ["ui", "hud", "button", "icon"])) {
      addSkill(routes, "ui-graphics", "HUD/icon/UI image asset workflow.", 260);
    } else {
      addSkill(routes, "concept-art", "Explore visual direction before final assets.", 220);
    }
  }

  if (target === "audio" && assetIntent) {
    if (includesAny(text, ["music", "theme", "track", "boss"])) {
      addSkill(routes, "music-track", "Music generation workflow.", 280);
    } else if (includesAny(text, ["ambient", "ambience", "atmosphere"])) {
      addSkill(routes, "ambient-bed", "Looping ambience workflow.", 260);
    } else if (includesAny(text, ["voice", "dialogue", "vo", "line"])) {
      addSkill(routes, "voice-line", "Voice/dialogue generation workflow.", 260);
    } else {
      addSkill(routes, "sound-effect", "One-shot SFX workflow.", 260);
    }
    addSkill(routes, "audio-direction", "Keep audio style coherent across the game.", 150);
  }

  if (target === "animation") {
    addSkill(routes, "generate-motion", "Generate curated humanoid motion on a rigged character.", 280);
    if (includesAny(text, ["blend", "state machine", "animationtree", "tree"])) {
      addSkill(routes, "animation-tree", "Wire clips into an AnimationTree/state machine.", 260);
    }
    if (includesAny(text, ["retarget", "reuse", "another character"])) {
      addSkill(routes, "retarget", "Reuse motion across compatible rigs.", 260);
    }
  }

  if (target === "level") {
    addSkill(routes, "design-level", "Build level structure, pacing, landmarks, and routes.", 270);
    addSkill(routes, "scene-to-level", "Convert scene goals into playable level layout.", 210);
    addSkill(routes, "scene-composition", "Use robust node/scene composition patterns.", 180);
  }

  if (target === "npc") {
    addSkill(routes, "design-npc", "NPC behavior/dialogue integration workflow.", 270);
    addSkill(routes, "gdscript-patterns", "Typed scripts/signals for NPC behavior.", 150);
  }

  if (target === "ui") {
    addSkill(routes, "ui-basics", "HUD/menu/control composition workflow.", 270);
    addSkill(routes, "gdscript-patterns", "Typed signal and state patterns for UI code.", 150);
  }

  if (target === "multiplayer") {
    addSkill(routes, "setup-multiplayer", "Choose networking model before implementation.", 270);
    addSkill(routes, "host-authoritative-state", "Server-authoritative state model.", 220);
  }

  if (includesAny(text, ["player controller", "fps", "first person", "wasd", "camera"])) {
    addSkill(routes, "fps-controller", "Player controller, camera, collision, and input bindings.", 240);
  }

  if (includesAny(text, ["shooter", "arena shooter", "fps"])) {
    addSkill(routes, "fps-controller", "Shooter input/camera/controller foundation.", 245);
    addSkill(routes, "design-mechanic", "Implement the core shooting/combat loop.", 230);
    addSkill(routes, "design-level", "Shape the arena, spawn space, cover, and pacing.", 210);
  }

  addSkill(routes, "gdscript-patterns", "Use guarded Summer file tools for scripts, then verify through MCP.", 90);
  addSkill(routes, "verification-before-completion", "Do not finish without a clean verification story.", 80);

  return routes
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 7)
    .map((route) => {
      const skill = skillByName().get(route.name) as SkillRegistryEntry;
      return {
        id: skill.id,
        name: skill.name,
        why: route.why,
      };
    });
}

function buildMcpToolPlan(
  mode: GameTaskPlan["mode"],
  target: GameTaskPlan["target"],
  assetPolicy: AssetPolicy,
  verification: VerificationLevel,
  goal = ""
): GameTaskPlan["mcpToolPlan"] {
  const text = goal.toLowerCase();
  const animationIntent = includesAny(text, [
    "animated",
    "animation",
    "animate",
    "idle",
    "walk",
    "run",
    "jump",
    "attack",
    "motion",
    "mocap",
    "locomotion",
  ]);
  const start = ["summer_start_game_task", "summer_get_project_context", "summer_get_agent_playbook"];
  const mutate = ["summer_open_main_scene", "summer_get_scene_tree", "summer_add_node", "summer_set_prop", "summer_save_scene"];
  const assets: string[] = [];
  const verify: string[] = [];

  if (mode === "debug") {
    start.push("summer_get_diagnostics", "summer_get_script_errors", "summer_get_debugger_errors");
  }

  if (target === "animation") {
    assets.push("summer_search_assets", "summer_get_asset", "summer_generate_motion");
  } else if (target === "3d" || target === "2d" || target === "audio") {
    assets.push("summer_search_assets", "summer_list_my_assets", "summer_get_asset", "summer_import_asset_by_id");
    if (assetPolicy !== "no-paid-generation") {
      if (target === "3d") assets.push("summer_generate_3d");
      if (target === "2d") assets.push("summer_generate_image");
      if (target === "audio") assets.push("summer_generate_audio");
      if (target === "3d" && animationIntent) assets.push("summer_generate_motion");
      assets.push("summer_check_job");
    }
  } else if (assetPolicy !== "no-paid-generation") {
    assets.push("summer_search_assets", "summer_import_asset");
  }

  if (verification !== "none") {
    // Rung 1-2 of the ladder: does it compile / does it look right.
    verify.push("summer_get_script_errors", "summer_get_diagnostics", "summer_screenshot");
  }
  if (verification === "full") {
    // Rung 3: run it and read runtime errors. Ordered as the composed loop —
    // clear -> play -> read runtime errors -> look at the live frame -> stop.
    // (There is no single "verify" tool; the agent composes these.)
    verify.push(
      "summer_clear_console",
      "summer_play",
      "summer_get_debugger_errors",
      "summer_screenshot",
      "summer_stop"
    );
  }

  return { start, mutate, assets, verify };
}

function buildUserGates(mode: GameTaskPlan["mode"], assetPolicy: AssetPolicy): string[] {
  const gates = [
    "Ask before destructive scene changes, deleting assets, or changing locked .summer memory.",
  ];
  if (assetPolicy !== "generate-when-clearly-needed") {
    gates.push("Ask before paid generation, rigging, video, or large batch asset creation.");
  }
  if (mode === "new-game") {
    gates.push("Lock one narrow playable loop before expanding scope.");
  }
  if (mode === "asset") {
    gates.push("For generated 3D characters, show the unrigged preview before paid rigging.");
  }
  return gates;
}

export function buildGameTaskPlan(options: GameTaskPlanOptions): GameTaskPlan {
  const goal = options.goal.trim();
  if (!goal) throw new Error("goal is required");

  const assetPolicy = options.assetPolicy ?? "ask-before-paid-generation";
  const verification = options.verification ?? "full";
  const mode = inferMode(goal, options.mode ?? "auto");
  const target = inferTarget(goal, options.target ?? "auto");

  return {
    goal,
    mode,
    target,
    assetPolicy,
    verification,
    principles: [
      "The agent should build a playable game slice, not a static demo.",
      "Use identity-bound Summer file tools for code/data/docs and Summer scene tools for live hierarchy/inspector changes.",
      "Reuse/import assets before paid generation unless the user explicitly wants custom output.",
      "Prefer exact IDs and structured tool results over search guesses after asset creation.",
      "Verify through the engine before claiming completion.",
    ],
    recommendedSkills: inferSkills(mode, target, goal),
    mcpToolPlan: buildMcpToolPlan(mode, target, assetPolicy, verification, goal),
    hostFileWork: [
      "Read and mutate project text through summer_read_file, summer_replace_text, and guarded summer_write_file.",
      "Use create_only:true for new files and an engine sha256 receipt for overwrites.",
      "Read relevant .summer memory files when project context reports them.",
    ],
    userGates: buildUserGates(mode, assetPolicy),
    nextAgentSteps: [
      "Call summer_get_project_context and read relevant .summer memory.",
      "Open the main scene if no scene is active.",
      "Load the top recommended skill before mutating the project.",
      "Make the smallest coherent change that advances the playable loop.",
      "Save, run diagnostics, and playtest according to the verification level.",
    ],
    antiPatterns: [
      "Do not hand-edit .tscn scene structure when Summer MCP can mutate the live scene.",
      "Do not generate assets before checking library/user assets.",
      "Do not search by name for an asset immediately after generation; use the returned asset ID.",
      "Do not finish with only code changes when the request affects gameplay; run engine verification.",
    ],
  };
}
