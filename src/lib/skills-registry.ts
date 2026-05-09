export const AGENT_CLIENTS = [
  "summer",
  "codex",
  "claude-code",
  "cursor",
  "windsurf",
] as const;

export type AgentClient = (typeof AGENT_CLIENTS)[number];

export const SKILL_CATEGORIES = [
  "_meta",
  "character-controllers",
  "gameplay-mechanics",
  "scripting-patterns",
  "scene-and-project",
  "rendering-and-lighting",
  "shaders",
  "visual-effects",
  "post-processing",
  "animation",
  "audio",
  "physics",
  "multiplayer-and-networking",
  "ai-and-npcs",
  "level-design",
  "performance",
  "ui-and-ux",
  "asset-pipeline",
  "input-and-controls",
  "debugging",
  "deployment",
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export interface SkillRegistryEntry {
  name: string;
  category: SkillCategory;
  public: boolean;
  clients: readonly AgentClient[];
  recommended: boolean;
  requiresMcpTools: readonly string[];
  testScenario: string;
}

const ALL_CLIENTS = AGENT_CLIENTS;

/**
 * Skills with `status: HAVE` in catalog.yaml. The catalog is the planning source
 * of truth (~85 skills); this TS registry is the install-time list (only skills
 * with shippable content). When a NEXT skill ships, mirror it here.
 */
export const SKILL_REGISTRY = [
  {
    name: "debug",
    category: "debugging",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_console",
      "summer_get_debugger_errors",
      "summer_get_script_errors",
      "summer_get_diagnostics",
      "summer_clear_console",
      "summer_play",
      "summer_stop",
      "summer_inspect_node",
    ],
    testScenario:
      "Triage a runtime crash end-to-end: read errors, locate code, propose fix, apply on approval, verify.",
  },
  {
    name: "play",
    category: "scene-and-project",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_is_running",
      "summer_play",
      "summer_stop",
      "summer_clear_console",
      "summer_get_diagnostics",
      "summer_get_debugger_errors",
      "summer_get_script_errors",
    ],
    testScenario:
      "Run the game from a clean state, wait for first frame, report whether it runs cleanly or has errors.",
  },
  {
    name: "gdscript-patterns",
    category: "scripting-patterns",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_script_errors",
    ],
    testScenario:
      "Write a typed GDScript with a signal, attach it to a node, connect the signal, and verify script errors.",
  },
  {
    name: "scene-composition",
    category: "scene-and-project",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_create_scene",
      "summer_open_scene",
      "summer_get_scene_tree",
      "summer_add_node",
      "summer_instantiate_scene",
      "summer_save_scene",
    ],
    testScenario:
      "Build a small reusable player scene, instantiate it in a main scene, and save both scenes through Summer tools.",
  },
  {
    name: "fps-controller",
    category: "character-controllers",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_input_map_bind",
    ],
    testScenario:
      "Create a CharacterBody3D player with collision, camera, input actions, and a host-edited controller script.",
  },
  {
    name: "3d-lighting",
    category: "rendering-and-lighting",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
    ],
    testScenario:
      "Add sun, fill lighting, WorldEnvironment, and shadow settings to a simple 3D scene.",
  },
  {
    name: "ui-basics",
    category: "ui-and-ux",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_connect_signal",
    ],
    testScenario:
      "Create a HUD CanvasLayer with labels, a ProgressBar, and a connected Button signal.",
  },
  {
    name: "asset-strategy",
    category: "asset-pipeline",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_search_assets",
      "summer_import_asset",
      "summer_import_from_url",
      "summer_generate_image",
      "summer_generate_3d",
      "summer_generate_audio",
    ],
    testScenario:
      "Choose library, generated, or primitive assets for a small level and import one asset into the project.",
  },
  {
    name: "make-game",
    category: "scene-and-project",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_agent_playbook",
      "summer_get_project_context",
      "summer_create_scene",
      "summer_open_scene",
      "summer_save_scene",
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_instantiate_scene",
      "summer_play",
      "summer_stop",
      "summer_get_diagnostics",
    ],
    testScenario:
      "Build one narrow playable prototype from requirements through scene setup, host-edited scripts, and diagnostics.",
  },
  {
    name: "brainstorm-game",
    category: "scene-and-project",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_project_context",
      "summer_get_scene_tree",
    ],
    testScenario:
      "Walk a fresh user from \"I want to make a game but I don't know what\" to a 1-page brief saved at .summer/GameSoul.md.",
  },
  {
    name: "new-project",
    category: "scene-and-project",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_project_context",
    ],
    testScenario:
      "User says \"start a blank project\" — skill asks for the name, picks empty vs 3d-basic, runs summer create, opens the engine, and stops to ask what to build.",
  },
  {
    name: "browse-templates",
    category: "scene-and-project",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_project_context",
    ],
    testScenario:
      "User says \"what templates exist?\" — skill runs summer list templates, presents 3-5 curated picks, asks the project name, and runs summer create <slug> <name>.",
  },
  {
    name: "design-mechanic",
    category: "gameplay-mechanics",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_add_node",
      "summer_set_prop",
      "summer_input_map_bind",
      "summer_save_scene",
      "summer_get_script_errors",
    ],
    testScenario:
      "Design the double-jump mechanic end-to-end: input, response, feedback, failure modes, depth, then drop a GDScript stub and node sketch.",
  },
  {
    name: "design-level",
    category: "level-design",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_scene_tree",
      "summer_create_scene",
      "summer_open_scene",
      "summer_add_node",
      "summer_set_prop",
      "summer_save_scene",
      "summer_get_script_errors",
    ],
    testScenario:
      "Design level 1, a 5-minute combat encounter that teaches parry, and produce a node-tree skeleton ready for summer_create_scene.",
  },
  {
    name: "art-direction",
    category: "rendering-and-lighting",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_project_context",
      "summer_project_setting",
      "summer_inspect_node",
      "summer_set_prop",
    ],
    testScenario:
      "Define art direction for a cozy farming sim using Stardew Valley and Sable as references; write the bible to .summer/art-bible.md.",
  },
  {
    name: "audio-direction",
    category: "audio",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_project_context",
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_add_node",
      "summer_project_setting",
      "summer_generate_audio",
    ],
    testScenario:
      "Define audio direction (music + SFX vocabulary + dynamic plan) for a cozy farming sim; write .summer/audio-bible.md and configure the audio bus layout.",
  },
  {
    name: "vfx",
    category: "visual-effects",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_inspect_resource",
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_connect_signal",
      "summer_save_scene",
      "summer_get_script_errors",
      "summer_play",
      "summer_stop",
    ],
    testScenario:
      "Add visible juice to flat combat hits in a 30-minute polish pass: hit flash, screen shake, particles, with verified scene state changes.",
  },
  {
    name: "tune-performance",
    category: "performance",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_diagnostics",
      "summer_get_console",
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_inspect_resource",
      "summer_play",
      "summer_stop",
      "summer_is_running",
      "summer_clear_console",
      "summer_set_prop",
      "summer_project_setting",
    ],
    testScenario:
      "Profile a slow forest scene (~22 fps), identify the rendering hotspot via diagnostics, propose a fix, verify the metric moved.",
  },
  {
    name: "design-npc",
    category: "ai-and-npcs",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_connect_signal",
      "summer_save_scene",
      "summer_get_script_errors",
      "summer_input_map_bind",
    ],
    testScenario:
      "Design a basic patrol-and-chase enemy with perception, decision logic, tells, and defeat handling; output state-machine GDScript stub plus scene tree.",
  },
  {
    name: "setup-multiplayer",
    category: "multiplayer-and-networking",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_add_node",
      "summer_set_prop",
      "summer_connect_signal",
      "summer_save_scene",
      "summer_get_script_errors",
      "summer_project_setting",
      "summer_play",
      "summer_stop",
    ],
    testScenario:
      "Add co-op LAN multiplayer (2-4 players) using MultiplayerAPI + MultiplayerSpawner + MultiplayerSynchronizer + ENet; lock authority model up front.",
  },
  {
    name: "peer-to-peer-multiplayer",
    category: "multiplayer-and-networking",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_create_scene",
      "summer_add_node",
      "summer_set_prop",
      "summer_connect_signal",
      "summer_save_scene",
      "summer_get_script_errors",
      "summer_project_setting",
    ],
    testScenario:
      "Build the four-layer P2P architecture from the ground up (NetworkManager + GameState + RPC patterns + prediction/interpolation) for a 2-player co-op game.",
  },
  {
    name: "host-authoritative-state",
    category: "multiplayer-and-networking",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_save_scene",
      "summer_get_script_errors",
    ],
    testScenario:
      "Walk a 17-field state ownership audit, design a HealthManager + ScoreManager with the canonical Manager pattern, and verify late-join state replay works.",
  },
  {
    name: "export-and-ship",
    category: "deployment",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_project_setting",
      "summer_get_console",
      "summer_get_diagnostics",
    ],
    testScenario:
      "Run the Steam pre-flight checklist (Windows + Mac + Linux), validate icons/banners/screenshots/build config, and produce a release build only when green.",
  },
] as const satisfies readonly SkillRegistryEntry[];
