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
  "2d-assets",
  "3d-assets",
  "video",
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
    name: "game-feel",
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
  {
    name: "concept-art",
    category: "2d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_generate_image",
      "summer_search_assets",
      "summer_import_from_url",
    ],
    testScenario:
      "User asks for 'concept art for the protagonist' — skill produces 3-4 variant prompts on a locked style anchor and writes prompts to art/concept/_prompts.md as fallback when MCP unavailable.",
  },
  {
    name: "character-portrait",
    category: "2d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_generate_image",
      "summer_search_assets",
      "summer_import_from_url",
    ],
    testScenario:
      "User asks for a 'final portrait of the queen for dialogue UI' — skill locks composition, generates one polished bust against a locked anchor, imports as res://art/portraits/queen.png.",
  },
  {
    name: "pixel-art",
    category: "2d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_generate_image",
      "summer_search_assets",
      "summer_import_from_url",
    ],
    testScenario:
      "User requests a '64x64 pixel art heart icon' — skill generates with style: 'pixel', enforces nearest-neighbor texture filter project setting, imports to res://art/sprites/.",
  },
  {
    name: "ui-graphics",
    category: "2d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_image",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User asks for an inventory grid icon set — skill generates flat-design transparent PNGs, sets up AtlasTexture import, wires into TextureRect / NinePatchRect.",
  },
  {
    name: "tileable-texture",
    category: "2d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_image",
      "summer_import_from_url",
      "summer_set_resource_property",
    ],
    testScenario:
      "User asks for a 'seamless brick wall texture' — skill generates with seamless prompt suffix, applies to PlaneMesh + StandardMaterial3D with uv1_scale tiled.",
  },
  {
    name: "sprite-sheet",
    category: "2d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_image",
      "summer_import_from_url",
      "summer_set_resource_property",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User requests a '4-frame walk cycle for the goblin' — skill generates per-frame at locked anchor, builds SpriteFrames resource, wires AnimatedSprite2D.",
  },
  {
    name: "skybox-panorama",
    category: "2d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_image",
      "summer_import_from_url",
      "summer_set_resource_property",
    ],
    testScenario:
      "User asks for a 'sunset desert skybox' — skill generates equirectangular 2:1 panorama, wires PanoramaSkyMaterial on WorldEnvironment.",
  },
  {
    name: "prop-model",
    category: "3d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_generate_3d",
      "summer_search_assets",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User asks for 'a treasure chest' — skill calls summer_generate_3d via image-to-3d pipeline with white-background prompt suffix, imports as MeshInstance3D.",
  },
  {
    name: "character-model",
    category: "3d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_generate_image",
      "summer_generate_3d",
      "summer_generate_motion",
      "summer_search_assets",
      "summer_inspect_resource",
      "summer_add_node",
      "summer_set_prop",
      "summer_save_scene",
    ],
    testScenario:
      "User asks for 'a knight character' — skill produces T-pose ref via image, gates rig pass on user approval, imports rigged glb, wires CharacterBody3D + Skeleton3D, hands off to animation/generate-motion.",
  },
  {
    name: "environment-kit",
    category: "3d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_3d",
      "summer_search_assets",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
      "summer_save_scene",
    ],
    testScenario:
      "User asks for 'a dungeon kit' — skill locks style anchor, generates 5-10 modular pieces with consistent prompt suffix, imports on snap-grid.",
  },
  {
    name: "vehicle-model",
    category: "3d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_3d",
      "summer_search_assets",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User asks for 'a sci-fi hover bike' — skill provides multi-angle reference, generates with hard-surface model preference, recommends texture pass for panel detail.",
  },
  {
    name: "organic-model",
    category: "3d-assets",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_3d",
      "summer_search_assets",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User asks for 'a glowing mushroom cluster' — skill generates organic shape via summer_generate_3d, imports with emission material, suggests MultiMeshInstance3D for forest fill.",
  },
  {
    name: "generate-motion",
    category: "animation",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_generate_motion",
      "summer_check_job",
      "summer_search_assets",
      "summer_inspect_resource",
      "summer_get_scene_tree",
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_save_scene",
    ],
    testScenario:
      "User asks for 'a walk animation on the goblin' — skill verifies the rigged target, picks meshy-library backend for standard 'walk', wires the clip into AnimationPlayer.",
  },
  {
    name: "retarget",
    category: "animation",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_motion",
      "summer_search_assets",
      "summer_inspect_resource",
      "summer_set_resource_property",
      "summer_save_scene",
    ],
    testScenario:
      "User asks to 'apply the goblin's walk to the orc' — skill identifies the source clip, retargets to the orc skeleton via SkeletonProfile, wires into the orc's AnimationPlayer.",
  },
  {
    name: "animation-tree",
    category: "animation",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_save_scene",
    ],
    testScenario:
      "User has idle/walk/run clips — skill builds an AnimationTree with a BlendSpace1D driven by speed, wires the BlendTree to the player controller.",
  },
  {
    name: "procedural-animation",
    category: "animation",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_get_scene_tree",
      "summer_inspect_node",
      "summer_add_node",
      "summer_set_prop",
      "summer_save_scene",
    ],
    testScenario:
      "User asks for 'foot IK so the character doesn't sink into stairs' — skill adds SkeletonModification3DLookAt + raycasting on each foot, wires into the character's Skeleton3D.",
  },
  {
    name: "facial-and-lipsync",
    category: "animation",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_inspect_resource",
      "summer_set_resource_property",
      "summer_save_scene",
      "summer_generate_audio",
    ],
    testScenario:
      "User has a voice line and wants the character to lip-sync to it — skill generates phoneme markers, builds blend-shape animation track on the character's MeshInstance3D.",
  },
  {
    name: "sound-effect",
    category: "audio",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_generate_audio",
      "summer_search_assets",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User asks for 'a sword swing sound' — skill reads audio bible, builds ElevenLabs SFX prompt with material+action+intensity, wires AudioStreamPlayer3D on the SFX bus.",
  },
  {
    name: "music-track",
    category: "audio",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_generate_audio",
      "summer_search_assets",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User asks for 'ambient forest theme music for level 1' — skill generates 60s loop via ElevenLabs music, imports with loop enabled, wires AudioStreamPlayer on Music bus.",
  },
  {
    name: "ambient-bed",
    category: "audio",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_audio",
      "summer_search_assets",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User asks for 'rain on tin roof ambience' — skill generates loop-clean ambience, sets up positional or non-positional player on Ambient bus.",
  },
  {
    name: "voice-line",
    category: "audio",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_generate_audio",
      "summer_search_assets",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User asks for 'the king says: you have served me well' — skill picks a voice ID matching character traits, generates TTS, wires to character's mouth via AudioStreamPlayer3D.",
  },
  {
    name: "adaptive-music",
    category: "audio",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_audio",
      "summer_search_assets",
      "summer_inspect_node",
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
    ],
    testScenario:
      "User wants combat music that swells when enemies are nearby — skill generates layered stems (calm, tension, combat), wires AudioStreamPlaybackInteractive with combat-state listener.",
  },
  {
    name: "cinematic-cutscene",
    category: "video",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_generate_video",
      "summer_generate_image",
      "summer_generate_audio",
      "summer_search_assets",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User asks for 'an opening cutscene where the hero arrives at the castle' — skill builds reference image, generates 5-10s shot via image-to-video, wires VideoStreamPlayer in cutscene scene.",
  },
  {
    name: "trailer-shot",
    category: "video",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_video",
      "summer_generate_image",
      "summer_search_assets",
      "summer_import_from_url",
    ],
    testScenario:
      "User asks for 'a hero shot of the boss for the trailer' — skill picks kling for premium quality, generates 5s low-angle dramatic shot, exports to assets/trailer/.",
  },
  {
    name: "animated-loop",
    category: "video",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_generate_video",
      "summer_search_assets",
      "summer_import_from_url",
      "summer_add_node",
      "summer_set_prop",
    ],
    testScenario:
      "User asks for 'a looping fire backdrop for the title screen' — skill generates 3-5s loop-clean clip via ltx, wires VideoStreamPlayer with autoplay+loop in title scene.",
  },
  {
    name: "fire",
    category: "visual-effects",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_inspect_node",
      "summer_save_scene",
    ],
    testScenario:
      "User asks for 'a torch flame' — skill creates GPUParticles3D with custom shader, writes addons/vfx/fire/{fire.gdshader, fire_controller.gd}, wires to scene.",
  },
  {
    name: "muzzle-flash",
    category: "visual-effects",
    public: true,
    clients: ALL_CLIENTS,
    recommended: true,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_inspect_node",
      "summer_save_scene",
    ],
    testScenario:
      "User asks for 'a muzzle flash on the rifle' — skill creates one-shot GPUParticles3D with star-burst shader, wires restart() on weapon-fire signal.",
  },
  {
    name: "water-ripple",
    category: "visual-effects",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_inspect_node",
      "summer_save_scene",
    ],
    testScenario:
      "User wants 'water ripples when objects splash' — skill creates MeshInstance3D plane with custom water shader, exposes add_ripple(position) API.",
  },
  {
    name: "lightning",
    category: "visual-effects",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_inspect_node",
      "summer_save_scene",
      "summer_connect_signal",
    ],
    testScenario:
      "User wants 'a lightning strike VFX' — skill builds ImmediateMesh-based jagged-segment renderer with shader, calls CameraShake.add_trauma(0.6) on cast.",
  },
  {
    name: "dissolve",
    category: "visual-effects",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_inspect_node",
      "summer_save_scene",
    ],
    testScenario:
      "User wants 'an enemy that dissolves on death' — skill writes dissolve.gdshader override + dissolve_object(target, duration) controller, animates threshold uniform.",
  },
  {
    name: "smoke",
    category: "visual-effects",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_inspect_node",
      "summer_save_scene",
    ],
    testScenario:
      "User wants 'smoke from a burning torch' — skill creates GPUParticles3D + smoke shader using shared FBM noise, wires wind direction parameter.",
  },
  {
    name: "hit-spark",
    category: "visual-effects",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_inspect_node",
      "summer_save_scene",
    ],
    testScenario:
      "User wants 'sparks when a sword hits metal' — skill spawns one-shot GPUParticles3D with additive billboard material, orients to surface normal.",
  },
  {
    name: "magic-glow",
    category: "visual-effects",
    public: true,
    clients: ALL_CLIENTS,
    recommended: false,
    requiresMcpTools: [
      "summer_add_node",
      "summer_set_prop",
      "summer_set_resource_property",
      "summer_inspect_node",
      "summer_save_scene",
    ],
    testScenario:
      "User wants 'a magical glow on a rune' — skill creates OmniLight3D with pulse-on-sin script + GPUParticles3D motes, uses additive billboard material from building blocks.",
  },
] as const satisfies readonly SkillRegistryEntry[];
