import { SKILL_REGISTRY, type SkillRegistryEntry } from "./skills-registry.js";

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
export const IDEA_STATES = ["vague", "concrete"] as const;

export type GameTaskMode = (typeof GAME_TASK_MODES)[number];
export type GameTaskTarget = (typeof GAME_TASK_TARGETS)[number];
export type AssetPolicy = (typeof ASSET_POLICIES)[number];
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];
export type IdeaState = (typeof IDEA_STATES)[number];

export interface GameTaskPlanOptions {
  goal: string;
  mode?: GameTaskMode;
  target?: GameTaskTarget;
  assetPolicy?: AssetPolicy;
  verification?: VerificationLevel;
}

export interface SkillRoute {
  id: string;
  name: string;
  category: string;
  why: string;
  requiresMcpTools: readonly string[];
}

export interface GameTaskPlan {
  goal: string;
  mode: Exclude<GameTaskMode, "auto">;
  target: Exclude<GameTaskTarget, "auto"> | "general";
  assetPolicy: AssetPolicy;
  verification: VerificationLevel;
  ideaState: IdeaState;
  principles: string[];
  recommendedSkills: SkillRoute[];
  mcpToolPlan: {
    start: string[];
    mutate: string[];
    assets: string[];
    verify: string[];
  };
  hostFileWork: string[];
  materialQuestions: string[];
  completionCriteria: string[];
  userGates: string[];
  nextAgentSteps: string[];
  antiPatterns: string[];
}

type WeightedSkill = { name: string; why: string; weight: number };

const SKILL_BY_NAME: Map<string, SkillRegistryEntry> = new Map(
  SKILL_REGISTRY.map((skill) => [skill.name, skill])
);

function includesAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function hasCharacterIntent(text: string): boolean {
  return (
    /\b(character|player|avatar|humanoid|girl|woman|man|witch|anime)\b/.test(text) ||
    includesAny(text, [
      "персонаж",
      "игрок",
      "девуш",
      "женщин",
      "мужчин",
      "ведьм",
      "аниме",
    ])
  );
}

function hasDirectCharacterCreation(text: string): boolean {
  if (
    hasDirectAnimationCreation(text) ||
    /\b(character (controller|system|behavior)|enemy (spawner|system|behavior)|npc (dialogue )?system)\b/.test(
      text
    )
  ) {
    return false;
  }
  return (
    /\bgenerate\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+){0,4}(character|enemy|npc|player|avatar|girl|woman|man|witch)\b/.test(
      text
    ) ||
    /\b(create|make|design)\s+(?:an?\s+|the\s+)?(?=[^.\n]{0,50}\b(custom|animated|3d|rigged|game-ready)\b)(?:[\w-]+\s+){0,5}(character|enemy|npc|player|avatar|girl|woman|man|witch)\b/.test(
      text
    ) ||
    /(сгенер\w*|созд\w*|сдел\w*)\s+(?:\w+\s+){0,4}(персонаж\w*|враг\w*|игрок\w*|девуш\w*|ведьм\w*)/.test(
      text
    )
  );
}

function hasDirectAnimationCreation(text: string): boolean {
  return (
    /\b(create|generate|make|add)\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+){0,3}(animation clip|motion clip|(run|idle|walk|jump|attack|fall|landing) animation)\b/.test(
      text
    ) ||
    /(созд\w*|сгенер\w*|сдел\w*|добав\w*).{0,40}(анимационн\w*\s+клип\w*|анимац\w*\s+(бег\w*|прыж\w*|паден\w*|приземлен\w*))/.test(
      text
    )
  );
}

function inferMode(goal: string, requested: GameTaskMode): Exclude<GameTaskMode, "auto"> {
  if (requested !== "auto") return requested;
  const text = goal.toLowerCase();
  const gameGenre = includesAny(text, [
    "shooter",
    "platformer",
    "parkour",
    "roguelike",
    "rpg",
    "racing",
    "puzzle game",
    "survival",
    "tower defense",
    "metroidvania",
    "arena",
    "farming",
    "simulation",
    "sim game",
    "cozy game",
    "шутер",
    "платформер",
    "паркур",
    "рогалик",
    "гонк",
    "головолом",
    "ферм",
    "симулятор",
  ]);
  const buildVerb =
    /(^|\s)(make|build|create|start|сделай|создай|построй)\s/.test(text) ||
    /(^|\s)хочу\s+(сделать|создать|построить)\s/.test(text);
  const existingGameIntent =
    /\b(existing|current|this|my|our|same)\s+(game|project)\b/.test(text) ||
    includesAny(text, [
      "существующ",
      "текущ",
      "этой игр",
      "эту игр",
      "моей игр",
      "мою игр",
      "нашей игр",
    ]);
  const directAssetCreation =
    /\b(make|create|generate|produce|design)\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+){0,3}(3d\s+asset|model\s+asset|character\s+asset|asset|model|sprite|texture|sound\s+effect|sfx|music\s+track|voice\s+line|animation\s+clip)\b/.test(
      text
    ) ||
    /(сгенер\w*|созд\w*|сдел\w*)\s+(?:\w+\s+){0,3}(ассет\w*|модел\w*|спрайт\w*|текстур\w*|звуков\w*\s+эффект\w*|музыкальн\w*\s+трек\w*|голосов\w*\s+реплик\w*|анимационн\w*\s+клип\w*)/.test(
      text
    ) ||
    hasDirectCharacterCreation(text) ||
    hasDirectAnimationCreation(text);
  const generalAssetRequest = includesAny(text, [
    "model asset",
    "3d asset",
    "character asset",
    "asset for",
    "music track",
    "sound effect",
    "voice line",
    "animation clip",
    "sprite sheet",
    "ассет",
    "модель для",
    "музыкальный трек",
    "звуковой эффект",
    "голосовая реплика",
    "анимационный клип",
  ]);
  const gameConstruction =
    /\b(make|build|create|start|prototype)\b.{0,60}\b(game|prototype)\b/.test(text) ||
    /(сдел\w*|созд\w*|постро\w*|нач\w*|прототип\w*).{0,60}(игр\w*|прототип\w*)/.test(
      text
    );
  const gameDesire =
    /\b(i want|i'd like|i would like)\b.{0,60}\bgame\b/.test(text) ||
    /\bхочу\b.{0,60}\bигр\w*\b/.test(text);
  if (includesAny(text, ["crash", "bug", "error", "broken", "fix", "debug", "not working", "баг", "ошиб", "слом", "почини"])) return "debug";
  if (includesAny(text, ["export", "ship", "release", "build for", "deploy"])) return "ship";
  if (includesAny(text, ["playtest", "test the game", "feel", "tune"])) return "playtest";
  if (directAssetCreation) return "asset";
  if (includesAny(text, ["polish", "lighting", "performance", "juice", "ui pass"])) return "polish";
  if (
    !existingGameIntent &&
    (includesAny(text, [
        "new game",
        "start a game",
        "make a game",
        "build a game",
        "create a game",
        "prototype",
        "from scratch",
        "сделай игру",
        "создай игру",
        "хочу игру",
        "новую игру",
        "прототип",
      ]) ||
      gameConstruction ||
      gameDesire ||
      (buildVerb && gameGenre))
  ) {
    return "new-game";
  }
  if (existingGameIntent) return "feature";
  if (generalAssetRequest) return "asset";
  return "feature";
}

function inferTarget(goal: string, requested: GameTaskTarget): GameTaskPlan["target"] {
  if (requested !== "auto") return requested;
  const text = goal.toLowerCase();
  if (/\b2d\b/.test(text) || text.includes("2д")) return "2d";
  if (/\b3d\b/.test(text) || text.includes("3д")) return "3d";
  if (/\b(ui|hud|menu|button|inventory)\b/.test(text) || includesAny(text, ["интерфейс", "меню", "кнопк", "инвентар"])) return "ui";
  if (/\b(sound|sfx|music|audio|voice|dialogue|ambient)\b/.test(text) || includesAny(text, ["звук", "музык", "голос", "диалог", "эмбиент"])) return "audio";
  if (hasDirectCharacterCreation(text)) return "3d";
  if (hasDirectAnimationCreation(text)) return "animation";
  if (hasCharacterIntent(text)) return "3d";
  if (/\b(animation|animate|idle|walk|run|attack|motion|retarget)\b/.test(text) || includesAny(text, ["анимац", "движен"])) return "animation";
  if (includesAny(text, ["level", "map", "dungeon", "arena", "room", "world"])) return "level";
  if (includesAny(text, ["npc", "enemy", "boss", "dialogue", "behavior"])) return "npc";
  if (includesAny(text, ["multiplayer", "network", "server", "host", "peer"])) return "multiplayer";
  if (/\b(sprite|pixel|portrait|icon|texture|tileset|skybox)\b/.test(text) || includesAny(text, ["спрайт", "пиксел", "портрет", "икон", "текстур", "тайл"])) return "2d";
  if (
    /\b(model|mesh|glb|prop|vehicle|tree|rock)\b/.test(text) ||
    includesAny(text, ["модел", "меш", "проп", "транспорт", "дерев", "камень"])
  ) {
    return "3d";
  }
  return "general";
}

function inferIdeaState(mode: GameTaskPlan["mode"], goal: string): IdeaState {
  if (mode !== "new-game") return "concrete";
  const text = goal.toLowerCase();
  if (
    includesAny(text, [
      "do not know what",
      "don't know what",
      "not sure what game",
      "help me decide",
      "не знаю какую",
      "не знаю, какую",
      "не знаю что",
      "давай придумаем",
      "побрейншторм",
    ])
  ) {
    return "vague";
  }

  const dimensionSignal = includesAny(text, ["2d", "3d", "2д", "3д"]);
  const genreSignal = includesAny(text, [
      "shooter",
      "platformer",
      "parkour",
      "roguelike",
      "rpg",
      "racing",
      "puzzle",
      "survival",
      "tower defense",
      "metroidvania",
      "arena",
      "farming",
      "simulation",
      "sim game",
      "cozy game",
      "шутер",
      "платформер",
      "паркур",
      "рогалик",
      "гонк",
      "головолом",
      "башен",
      "арен",
      "ферм",
      "симулятор",
    ]);
  const mechanicSignal = includesAny(text, [
      "jump",
      "fall",
      "respawn",
      "procedural",
      "collect",
      "fight",
      "shoot",
      "platform",
      "rotate",
      "connect",
      "before time",
      "timer",
      "defend",
      "plant",
      "harvest",
      "sell",
      "прыж",
      "пад",
      "возрож",
      "процедур",
      "собир",
      "стрел",
      "платформ",
      "вращ",
      "соедин",
      "таймер",
      "врем",
      "защищ",
      "саж",
      "урожай",
      "прода",
    ]);
  const characterSignal = hasCharacterIntent(text);
  const signals = [
    dimensionSignal,
    genreSignal,
    mechanicSignal,
    characterSignal,
  ];
  if (signals.filter(Boolean).length >= 2) return "concrete";

  const wordCount = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const hasRuleClause =
    /\b(where|with|that|who|before|after|using|while)\b/.test(text) ||
    /\b(где|котор\w*|чтобы|пока|после|до того)\b/.test(text);
  return genreSignal && wordCount >= 8 && hasRuleClause
    ? "concrete"
    : "vague";
}

function addSkill(routes: WeightedSkill[], name: string, why: string, weight: number): void {
  if (!SKILL_BY_NAME.has(name)) return;
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

function inferSkills(
  mode: GameTaskPlan["mode"],
  target: GameTaskPlan["target"],
  goal: string,
  ideaState: IdeaState
): SkillRoute[] {
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
    "fall",
    "landing",
    "анимац",
    "прыж",
    "бег",
    "паден",
    "приземлен",
  ]);
  const characterIntent = hasCharacterIntent(text);
  const assetIntent =
    mode === "asset" ||
    (mode === "new-game" &&
      (characterIntent ||
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
        ])));

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
    addSkill(routes, "make-game", "Build one narrow playable prototype end-to-end.", 330);
    if (ideaState === "vague") {
      addSkill(
        routes,
        "brainstorm-game",
        "The user has not chosen a game yet; discover and lock a small playable brief.",
        300
      );
    }
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
    if (characterIntent || includesAny(text, ["npc", "enemy", "boss", "rig"])) {
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
    if (animationIntent && (characterIntent || includesAny(text, ["npc", "enemy", "boss", "rig"]))) {
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

  addSkill(routes, "gdscript-patterns", "Use direct host file edits for scripts, then verify through MCP.", 90);
  addSkill(routes, "verification-before-completion", "Do not finish without a clean verification story.", 80);

  return routes
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 7)
    .map((route) => {
      const skill = SKILL_BY_NAME.get(route.name) as SkillRegistryEntry;
      return {
        id: `summer:${skill.category}/${skill.name}`,
        name: skill.name,
        category: skill.category,
        why: route.why,
        requiresMcpTools: skill.requiresMcpTools,
      };
    });
}

function buildMcpToolPlan(
  mode: GameTaskPlan["mode"],
  target: GameTaskPlan["target"],
  assetPolicy: AssetPolicy,
  verification: VerificationLevel
): GameTaskPlan["mcpToolPlan"] {
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
    gates.push(
      "For generated 3D characters, approve the reference and the paid complete rig-plus-animation request before generation."
    );
  }
  return gates;
}

function buildMaterialQuestions(
  mode: GameTaskPlan["mode"],
  ideaState: IdeaState,
  goal: string
): string[] {
  if (mode === "new-game" && ideaState === "vague") {
    return [
      "Ask in ordinary text: “Do you already know what game you want to make, or should we brainstorm it together?” Then wait for the answer.",
    ];
  }

  const text = goal.toLowerCase();
  const characterIntent = hasCharacterIntent(text);
  const sourceAlreadyChosen = includesAny(text, [
    "asset store",
    "asset library",
    "existing asset",
    "use an asset",
    "existing character",
    "current character",
    "this character",
    "existing rig",
    "this rig",
    "custom character",
    "placeholder",
    "prototype character",
    "магазин",
    "библиотек",
    "готовый ассет",
    "кастом",
    "заглуш",
    "прототип персонаж",
  ]) ||
    hasDirectCharacterCreation(text) ||
    /(generate|create|make)\s+(?:a\s+)?(?:custom\s+)?(?:character|player|girl|woman|man|witch|avatar)/.test(
      text
    ) ||
    /(сгенер\w*|созд\w*)\s+(?:кастом\w*\s+)?(?:персонаж\w*|игрок\w*|девуш\w*|ведьм\w*)/.test(
      text
    );

  if (
    (mode === "new-game" || mode === "asset") &&
    characterIntent &&
    !sourceAlreadyChosen
  ) {
    return [
      "Ask one ordinary text question: “Should I use an existing/Asset Store character, generate a custom character, or use a temporary prototype?” Do not render a menu. Do not ask unrelated visual or technical questions.",
    ];
  }
  return [];
}

function buildCompletionCriteria(
  mode: GameTaskPlan["mode"],
  goal: string
): string[] {
  if (mode !== "new-game") return [];
  const text = goal.toLowerCase();
  const criteria = [
    "The main scene launches with a visible, controllable player and a working camera.",
    "The requested core loop, failure/restart loop, and required collisions work at runtime.",
    "The game is played and checked through Summer MCP before completion is claimed.",
  ];
  if (includesAny(text, ["parkour", "platformer", "паркур", "платформер"])) {
    criteria.push(
      "Player movement and jumping work across multiple reachable platforms.",
      includesAny(text, ["procedural", "процедур"])
        ? "Procedurally generated platforms extend the playable route."
        : "The level contains a playable platform route.",
      includesAny(text, ["last valid platform", "последн", "предыдущ"])
        ? "Falling respawns the player on the last valid platform."
        : "Falling respawns the player at a valid checkpoint."
    );
  }
  const characterIntent = hasCharacterIntent(text);
  const animationIntent = includesAny(text, [
    "animated",
    "animation",
    "jump",
    "fall",
    "landing",
    "run",
    "анимац",
    "прыж",
    "паден",
    "приземлен",
    "бег",
  ]);
  if (characterIntent) {
    criteria.push(
      "The chosen character source is imported and connected to the player controller."
    );
  }
  if (characterIntent && animationIntent) {
    criteria.push(
      "The locomotion state machine plays idle, run, jump, fall, and landing animations in the corresponding gameplay states."
    );
  }
  return criteria;
}

export function buildGameTaskPlan(options: GameTaskPlanOptions): GameTaskPlan {
  const goal = options.goal.trim();
  if (!goal) throw new Error("goal is required");

  const assetPolicy = options.assetPolicy ?? "ask-before-paid-generation";
  const verification = options.verification ?? "full";
  const mode = inferMode(goal, options.mode ?? "auto");
  const target = inferTarget(goal, options.target ?? "auto");
  const ideaState = inferIdeaState(mode, goal);

  return {
    goal,
    mode,
    target,
    assetPolicy,
    verification,
    ideaState,
    principles: [
      "The agent should build a playable game slice, not a static demo.",
      "Use host file edits for code/data/docs; use MCP for live scene state, imports, inspector values, play, and diagnostics.",
      "Reuse/import assets before paid generation unless the user explicitly wants custom output.",
      "Prefer exact IDs and structured tool results over search guesses after asset creation.",
      "Verify through the engine before claiming completion.",
      "Do not ask about file or folder architecture, scene organization, sky, or other reversible implementation details.",
    ],
    recommendedSkills: inferSkills(mode, target, goal, ideaState),
    mcpToolPlan: buildMcpToolPlan(mode, target, assetPolicy, verification),
    hostFileWork: [
      "Write and edit .gd/.cs scripts directly with host file tools.",
      "Use direct file edits for JSON, markdown, project notes, and simple resources.",
      "Read relevant .summer memory files when project context reports them.",
    ],
    materialQuestions: buildMaterialQuestions(mode, ideaState, goal),
    completionCriteria: buildCompletionCriteria(mode, goal),
    userGates: buildUserGates(mode, assetPolicy),
    nextAgentSteps: [
      "Call summer_get_project_context and read relevant .summer memory.",
      "Open the main scene if no scene is active.",
      "Load the top recommended skill before mutating the project.",
      ideaState === "vague"
        ? "Run brainstorm-game and wait only for the game-defining answers."
        : "Treat the concrete brief as authorization to build; ask only the listed materialQuestions.",
      "Continue through the smallest complete playable loop; do not hand off an internal scaffold.",
      "Save, run diagnostics, playtest the completionCriteria, fix failures, and only then report the result.",
    ],
    antiPatterns: [
      "Do not hand-edit .tscn scene structure when Summer MCP can mutate the live scene.",
      "Do not generate assets before checking library/user assets.",
      "Do not search by name for an asset immediately after generation; use the returned asset ID.",
      "Do not finish with only code changes when the request affects gameplay; run engine verification.",
      "Do not present an empty scaffold, floor-and-camera scene, or non-interactive frame as the minimum game.",
      "Do not ask the user to choose file or folder architecture or other internal implementation details.",
    ],
  };
}
