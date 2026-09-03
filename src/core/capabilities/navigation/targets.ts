/**
 * The product map — every destination `summer open` / `summer_open` can land
 * on, web (summerengine.com, docs.summerengine.com) and editor (Summer Engine
 * over the local API). ONE table, two surfaces (docs/design/NAVIGATION-DESIGN.md §2).
 *
 * This file is the source of truth: the tool loads it, and
 * library/references/product-map/product-map.md is the same table rendered for
 * agents — navigation.test.ts fails when the two disagree on target ids.
 *
 * Verification (2026-09-03): every web path was checked against the route files
 * of the web repo (Studio `?tab=` list and AUTHENTICATED_STUDIO_TABS in
 * app/(app)/(studio)/studio/…, selected-game sections in
 * selected-game-navigation.ts, MCP guide slugs in src/lib/data/agent-guides.ts,
 * the `/login?returnUrl=` redirect in src/lib/auth/return-url.ts); every editor
 * op against the engine's op_registry.json (OpenScene, SelectNode, OpenResource,
 * FocusDock with exactly the dock ids file_system | scene_tree | inspector,
 * RevealInFileSystem). Anything the engine cannot do yet is `status: "planned"`
 * with the engine change named — the tool never pretends to open those.
 */

export type NavSurface = "web" | "editor";
export type NavStatus = "implemented" | "planned";
export type WebOrigin = "gateway" | "docs";

export interface NavParam {
  name: string;
  description: string;
  required?: boolean;
  /** Closed vocabulary, when one exists (validated). */
  values?: readonly string[];
  /** Friendly names that resolve to a value in `values` (e.g. "cursor" -> a guide slug). */
  valueAliases?: Readonly<Record<string, string>>;
}

export interface NavWeb {
  origin: WebOrigin;
  /** Path template. `{slot}` is a required param; `[/{slot}]` is an optional
   *  segment dropped when the param is absent. Query strings are literal. */
  path: string;
}

export interface NavEditor {
  /** Engine op kind, e.g. "OpenScene". */
  op: string;
  /** Fixed op fields, e.g. { dock: "inspector" }. */
  fixed?: Readonly<Record<string, string>>;
  /** Param name -> op field, e.g. { node: "nodePath", scene: "scenePath" }. */
  map?: Readonly<Record<string, string>>;
  /** When the `path` param is omitted, read application/run/main_scene. */
  mainSceneDefault?: boolean;
}

export interface NavTarget {
  id: string;
  surface: NavSurface;
  title: string;
  /** What the user sees when it opens. */
  description: string;
  /** Intent phrases, written the way users say them. */
  intents: readonly string[];
  /** Extra ids that resolve to this target. */
  aliases?: readonly string[];
  status: NavStatus;
  requires: { login?: boolean; engine?: boolean };
  web?: NavWeb;
  editor?: NavEditor;
  params?: readonly NavParam[];
  /** planned targets only: the engine change that would implement it. */
  engineChange?: string;
  /** planned targets only: the nearest implemented target, if any. */
  fallback?: string;
}

export const DOCS_ORIGIN = "https://docs.summerengine.com";

/** Slugs of the per-agent MCP setup guides (`/mcp/<guide>`), as published by the
 *  web repo (src/lib/data/agent-guides.ts). */
export const MCP_GUIDE_SLUGS = [
  "how-to-make-games-in-claude-code",
  "how-to-make-games-in-cursor",
  "how-to-make-games-in-codex",
  "how-to-make-games-in-devin-desktop",
  "how-to-make-games-in-gemini-cli",
  "how-to-make-games-in-cline",
  "how-to-make-games-in-kilo-code",
  "how-to-make-games-in-opencode",
  "how-to-make-games-for-free-with-local-llms",
  "how-to-make-games-with-ollama",
  "how-to-make-games-in-lm-studio",
  "how-to-make-games-in-goose",
] as const;

const MCP_GUIDE_ALIASES: Readonly<Record<string, string>> = {
  "claude-code": "how-to-make-games-in-claude-code",
  claude: "how-to-make-games-in-claude-code",
  cursor: "how-to-make-games-in-cursor",
  codex: "how-to-make-games-in-codex",
  "devin-desktop": "how-to-make-games-in-devin-desktop",
  devin: "how-to-make-games-in-devin-desktop",
  windsurf: "how-to-make-games-in-devin-desktop",
  "gemini-cli": "how-to-make-games-in-gemini-cli",
  gemini: "how-to-make-games-in-gemini-cli",
  cline: "how-to-make-games-in-cline",
  "kilo-code": "how-to-make-games-in-kilo-code",
  kilo: "how-to-make-games-in-kilo-code",
  opencode: "how-to-make-games-in-opencode",
  "local-llms": "how-to-make-games-for-free-with-local-llms",
  local: "how-to-make-games-for-free-with-local-llms",
  ollama: "how-to-make-games-with-ollama",
  "lm-studio": "how-to-make-games-in-lm-studio",
  goose: "how-to-make-games-in-goose",
};

/** Real URL segments under /studio/games/<gameId>/ (selected-game-navigation.ts). */
export const GAME_SECTIONS = [
  "overview",
  "builds",
  "releases",
  "store-page",
  "passport",
  "products",
  "achievements",
  "players",
  "community",
  "liveops",
  "safety",
  "analytics",
  "economy",
  "developers",
  "access",
  "audit",
  "danger-zone",
  "settings",
] as const;

const PATH_PARAM: NavParam = {
  name: "path",
  description: "Project resource path, e.g. res://levels/level_1.tscn",
  required: true,
};

function web(
  id: string,
  path: string,
  title: string,
  description: string,
  intents: string[],
  extra: Partial<NavTarget> = {}
): NavTarget {
  return {
    id,
    surface: "web",
    title,
    description,
    intents,
    status: "implemented",
    requires: {},
    web: { origin: "gateway", path },
    ...extra,
  };
}

function docs(id: string, path: string, title: string, description: string, intents: string[]): NavTarget {
  return {
    id,
    surface: "web",
    title,
    description,
    intents,
    status: "implemented",
    requires: {},
    web: { origin: "docs", path },
  };
}

function studioTab(
  id: string,
  tab: string,
  title: string,
  description: string,
  intents: string[],
  login: boolean,
  extra: Partial<NavTarget> = {}
): NavTarget {
  return web(id, `/studio?tab=${tab}`, title, description, intents, {
    requires: login ? { login: true } : {},
    ...extra,
  });
}

function editor(
  id: string,
  title: string,
  description: string,
  intents: string[],
  spec: NavEditor,
  extra: Partial<NavTarget> = {}
): NavTarget {
  return {
    id,
    surface: "editor",
    title,
    description,
    intents,
    status: "implemented",
    requires: { engine: true },
    editor: spec,
    ...extra,
  };
}

function plannedEditor(
  id: string,
  title: string,
  description: string,
  intents: string[],
  op: string,
  engineChange: string,
  extra: Partial<NavTarget> = {}
): NavTarget {
  return {
    id,
    surface: "editor",
    title,
    description,
    intents,
    status: "planned",
    requires: { engine: true },
    editor: { op },
    engineChange,
    ...extra,
  };
}

export const NAV_TARGETS: readonly NavTarget[] = [
  // ---------------------------------------------------------------- web: public
  web("home", "/", "summerengine.com", "The Summer homepage.", [
    "summer website",
    "homepage",
    "the website",
    "summerengine.com",
  ]),
  web("pricing", "/pricing", "Pricing", "Free tier and paid AI-usage tiers; upgrade buttons start Stripe checkout.", [
    "pricing",
    "how much does it cost",
    "plans and prices",
    "what does summer cost",
    "compare plans",
  ]),
  web("download", "/download", "Download Summer Engine", "Desktop installers for macOS and Windows.", [
    "download the app",
    "download summer engine",
    "install summer engine",
    "get the desktop app",
    "installer",
  ]),
  web("cli-guide", "/cli", "CLI guide", "How to install the summer-engine CLI and the one-paste agent prompt.", [
    "cli page",
    "how do i install the cli",
    "cli setup",
    "command line install",
  ]),
  web(
    "mcp-guide",
    "/mcp[/{guide}]",
    "MCP setup guide",
    "The MCP + CLI hub, or the step-by-step guide for one agent (Claude Code, Cursor, Codex, Gemini CLI, Cline, Kilo Code, OpenCode, Devin, local LLMs, Ollama, LM Studio, Goose).",
    [
      "mcp setup",
      "set up the mcp",
      "connect my agent",
      "how do i set up cursor",
      "how do i set up claude code",
      "how do i set up codex",
      "mcp guide for my agent",
      "agent setup guide",
    ],
    {
      params: [
        {
          name: "guide",
          description: "Guide slug or agent name (claude-code, cursor, codex, gemini, cline, kilo-code, opencode, devin, windsurf, ollama, lm-studio, goose, local-llms). Omit for the hub.",
          values: MCP_GUIDE_SLUGS,
          valueAliases: MCP_GUIDE_ALIASES,
        },
      ],
    }
  ),
  web("templates", "/templates", "Templates", "Browse every game template by category and use case.", [
    "browse templates",
    "template gallery",
    "game templates",
    "starter projects",
  ]),
  web("templates-start", "/templates/start", "Start a game on the web", "The web onboarding flow that turns a template pick into a plan.", [
    "start a new game on the web",
    "web onboarding",
    "plan builder",
  ]),
  web("asset-store", "/asset-store", "Asset Store", "Browse 2D art, 3D models, sprites, animations, music and sound effects.", [
    "asset store",
    "find assets",
    "browse assets",
    "free game assets",
  ]),
  web("plugins", "/plugins", "Plugins", "The public plugin and skill catalog.", ["plugins", "plugin catalog", "skills catalog"]),
  web(
    "changelog",
    "/changelog[/{version}]",
    "Changelog",
    "Release notes — the index, or one engine version.",
    ["changelog", "what's new", "release notes", "what changed in the last update"],
    { params: [{ name: "version", description: "Engine version, e.g. 0.5.65. Omit for the index." }] }
  ),
  web("blog", "/blog", "Blog", "The Summer blog.", ["blog", "blog posts", "articles"]),
  web("roadmap", "/roadmap", "Roadmap", "The public product roadmap.", ["roadmap", "what's coming", "planned features"]),
  web("games", "/games", "Games & jams", "The public gallery of featured games, jams and events.", [
    "games gallery",
    "featured games",
    "game jams",
    "jam",
    "community games",
  ]),
  docs("docs", "/", "Documentation", "docs.summerengine.com — the Summer documentation.", [
    "documentation",
    "the docs",
    "read the docs",
    "manual",
  ]),
  docs("docs-mcp", "/mcp/overview", "MCP docs", "The MCP overview in the documentation.", [
    "mcp docs",
    "mcp documentation",
    "how the mcp works",
  ]),
  docs("docs-install", "/essentials/installation", "Installation docs", "Installing Summer Engine, step by step.", [
    "installation docs",
    "install instructions",
    "how to install",
  ]),
  docs("docs-quickstart", "/quickstarts/fresh-project", "Quickstart", "Fresh-project quickstart in the documentation.", [
    "quickstart",
    "getting started guide",
    "first project tutorial",
  ]),
  docs("docs-sdk", "/api-reference/summer-sdk", "Summer SDK reference", "The Summer SDK API reference.", [
    "sdk reference",
    "sdk docs",
    "api reference",
    "summer sdk",
  ]),
  web("login", "/login", "Sign in", "The sign-in page (email/password or Google).", ["sign in", "log in", "login page"]),
  web("signup", "/signup", "Create an account", "The sign-up page.", ["sign up", "create an account", "register"]),

  // ---------------------------------------------------------------- web: studio
  web("studio", "/studio", "Summer Studio", "The Studio workspace (home tab).", ["studio", "summer studio", "open studio", "the studio"]),
  web(
    "my-games",
    "/studio/games",
    "My games",
    "Your games (projects) in Studio: overview, builds, releases, store pages.",
    [
      "my games",
      "my projects",
      "my published games",
      "published games",
      "my releases",
      "games i published",
      "project list",
      "list of my games",
    ],
    { requires: { login: true }, aliases: ["projects", "my-projects", "published-games"] }
  ),
  web(
    "game",
    "/studio/games/{gameId}[/{section}]",
    "A game in Studio",
    "One game's Studio pages: overview, builds, releases, store page, passport, players, analytics, economy, settings, danger zone and more.",
    [
      "open this game in studio",
      "builds for my game",
      "releases of my game",
      "store page for my game",
      "analytics for my game",
      "game settings in studio",
      "danger zone",
      "players of my game",
    ],
    {
      requires: { login: true },
      params: [
        { name: "gameId", description: "The game's Studio id (from the my-games list URL).", required: true },
        { name: "section", description: "Section under the game.", values: GAME_SECTIONS },
      ],
    }
  ),
  studioTab(
    "billing",
    "billing",
    "Billing & plan",
    "Current plan, upgrade, Stripe billing portal (payment method, invoices), top-ups.",
    [
      "billing",
      "change my plan",
      "upgrade my plan",
      "upgrade",
      "downgrade",
      "cancel my subscription",
      "invoices",
      "payment method",
      "subscription",
      "buy credits",
      "top up",
    ],
    true,
    { aliases: ["plan", "subscription", "payments"] }
  ),
  studioTab(
    "usage",
    "billing&section=usage",
    "Usage",
    "Account usage and spending — how many credits were used and on what.",
    ["usage", "how many credits do i have left", "spending", "credit usage", "what have i spent"],
    true,
    { aliases: ["spending", "credits"] }
  ),
  studioTab("account", "account", "Account overview", "Your account overview in Studio.", ["my account", "account overview", "account page", "profile settings"], true),
  studioTab(
    "settings",
    "settings",
    "Account settings",
    "Account settings in Studio (email, password, preferences, delete account).",
    ["account settings", "settings page", "change my email", "change my password", "delete my account"],
    true
  ),
  studioTab("team", "team", "Team", "Workspace members and invites.", ["team", "members", "invite a teammate", "workspace members", "add someone to my team"], true, {
    aliases: ["members", "workspace"],
  }),
  studioTab("cloud", "cloud", "Project Cloud", "Project Cloud storage and synced projects.", ["project cloud", "cloud storage", "cloud projects", "synced projects"], true),
  studioTab("my-assets", "assets", "My assets", "Assets you generated or saved, ready to import.", ["my assets", "generated assets", "my library", "saved assets", "assets i made"], false, {
    aliases: ["assets", "library"],
  }),
  studioTab("workflows", "workflows", "Guided workflows", "Guided Studio workflows (recipes).", ["guided workflows", "workflows", "studio recipes"], false),
  studioTab("story-builder", "storyBuilder", "Story Builder", "The Story Builder tool.", ["story builder", "write my story", "narrative tool"], true),
  studioTab("board", "board", "Board", "The project board.", ["board", "task board", "kanban"], true),
  studioTab("studio-plugins", "plugins", "Plugins in Studio", "Plugins tab inside Studio.", ["plugins in studio", "manage my plugins", "installed plugins"], false),
  studioTab("studio-store", "store", "Asset Store in Studio", "The Asset Store as a Studio tab.", ["asset store in studio", "store tab"], false),
  studioTab("generate-image", "image", "2D generation", "Generate or edit images (the 2D tab).", ["image generator", "generate an image on the web", "2d tab", "make a picture in studio"], false, {
    aliases: ["2d", "image"],
  }),
  studioTab("generate-3d", "3d", "3D generation", "Generate 3D models (the 3D tab).", ["3d generator", "generate a 3d model on the web", "3d tab"], false, { aliases: ["3d"] }),
  studioTab("generate-audio", "audio", "Audio generation", "Generate speech, music and sound effects.", ["audio generator", "generate audio on the web", "audio tab", "music generator", "voice generator"], false, {
    aliases: ["audio"],
  }),
  studioTab("generate-video", "video", "Video generation", "Generate video (the Video tab).", ["video generator", "generate a video on the web", "video tab"], false, { aliases: ["video"] }),
  studioTab("generate-animation", "animation", "Animation", "Animation tools (retargeting, mocap uploads).", ["animation tab", "animation tools", "retarget on the web", "upload a mocap clip"], false, {
    aliases: ["animation"],
  }),
  web("chat", "/chat", "Web chat", "A new agent chat on the web.", ["web chat", "chat on the website", "summer chat"], { requires: { login: true } }),
  web("skills", "/skills", "My skills", "The agent-skills editor on the web.", ["my skills page", "edit my skills on the web", "skills editor"], { requires: { login: true } }),
  web(
    "profile",
    "/{username}",
    "Public profile",
    "A creator's public profile page.",
    ["my public profile", "public profile of", "creator page", "see my profile"],
    { params: [{ name: "username", description: "The creator's username.", required: true }] }
  ),
  web("edit-profile", "/profile/edit", "Edit profile", "Edit your public profile.", ["edit my profile", "change my avatar", "update my bio", "profile editor"], {
    requires: { login: true },
  }),
  web("submit-game", "/games/create", "Submit a game", "Submit a game to the public gallery or a jam.", ["submit my game", "add my game to the gallery", "enter the jam", "submit to the jam"], {
    requires: { login: true },
  }),

  // ---------------------------------------------------------------- editor: implemented
  editor(
    "scene",
    "Open a scene",
    "The scene becomes the current tab in Summer Engine.",
    ["open the scene", "open this scene", "show the scene", "switch to the scene", "the scene i'm editing", "open my level"],
    { op: "OpenScene", map: { path: "path" }, mainSceneDefault: true },
    { params: [{ name: "path", description: "Scene path, e.g. res://main.tscn. Omit for the project's main scene." }] }
  ),
  editor(
    "main-scene",
    "Open the main scene",
    "The project's configured main scene becomes the current tab.",
    ["open the main scene", "main scene", "go to the main scene", "the starting scene"],
    { op: "OpenScene", mainSceneDefault: true }
  ),
  editor(
    "node",
    "Select a node",
    "The node is highlighted in the Scene tree and its properties show in the Inspector.",
    ["select the node", "show me the node", "focus the player node", "highlight the node", "go to the node", "inspect the node in the editor"],
    { op: "SelectNode", map: { node: "nodePath", scene: "scenePath" } },
    {
      params: [
        { name: "node", description: "Node path relative to the scene root, e.g. Player/Camera3D.", required: true },
        { name: "scene", description: "Scene to open first, e.g. res://main.tscn (optional)." },
      ],
    }
  ),
  editor(
    "script",
    "Open a script",
    "The script opens in the Script editor (the engine does not steal focus from where the user is typing).",
    ["open the script", "show me the script", "open the gdscript file", "go to the script", "open player.gd"],
    { op: "OpenResource", map: { path: "path" } },
    { params: [PATH_PARAM] }
  ),
  editor(
    "file",
    "Reveal a file",
    "The FileSystem dock comes to the front, scrolled to the file.",
    ["show the file in the filesystem", "reveal the file", "find the file in the editor", "where is this asset", "show me the texture in the file dock"],
    { op: "RevealInFileSystem", map: { path: "path" } },
    { params: [PATH_PARAM] }
  ),
  editor("files", "FileSystem dock", "The FileSystem dock comes to the front.", ["filesystem dock", "file dock", "show the files", "project files panel"], {
    op: "FocusDock",
    fixed: { dock: "file_system" },
  }, { aliases: ["filesystem", "file-system"] }),
  editor("scene-tree", "Scene tree dock", "The Scene tree dock comes to the front.", ["scene tree", "scene dock", "show the scene tree", "node tree panel"], {
    op: "FocusDock",
    fixed: { dock: "scene_tree" },
  }),
  editor("inspector", "Inspector dock", "The Inspector dock comes to the front.", ["inspector", "show the inspector", "properties panel", "inspector dock"], {
    op: "FocusDock",
    fixed: { dock: "inspector" },
  }),

  // ---------------------------------------------------------------- editor: planned
  plannedEditor(
    "screen-2d",
    "2D main screen",
    "The main editor switches to the 2D view.",
    ["switch to 2d", "2d view", "show the 2d editor"],
    "SetMainScreen",
    "new op SetMainScreen{screen} calling EditorInterface::set_main_screen_editor (exists only behind the chat webview bridge editor:show-viewport)"
  ),
  plannedEditor(
    "screen-3d",
    "3D main screen",
    "The main editor switches to the 3D view.",
    ["switch to 3d", "3d view", "show the 3d editor", "show me the viewport"],
    "SetMainScreen",
    "new op SetMainScreen{screen} calling EditorInterface::set_main_screen_editor"
  ),
  plannedEditor(
    "screen-script",
    "Script main screen",
    "The main editor switches to the Script editor.",
    ["switch to the script editor", "script view", "show the code editor"],
    "SetMainScreen",
    "new op SetMainScreen{screen} calling EditorInterface::set_main_screen_editor",
    { fallback: "script" }
  ),
  plannedEditor(
    "screen-game",
    "Game main screen",
    "The main editor switches to the Game view.",
    ["switch to the game view", "game tab", "show the running game view"],
    "SetMainScreen",
    "new op SetMainScreen{screen} calling EditorInterface::set_main_screen_editor"
  ),
  plannedEditor(
    "assistant",
    "Summer assistant",
    "The Summer assistant (chat) dock opens.",
    ["open the assistant", "show the chat dock", "summer assistant", "ai chat in the editor", "open the agent panel"],
    "FocusChat",
    "new op FocusChat{path?} over ChatDock::open_chat_path (today only the chat:open webview bridge message)"
  ),
  plannedEditor(
    "project-settings",
    "Project Settings",
    "The Project Settings dialog opens.",
    ["project settings", "settings", "open project settings", "input map settings", "autoload settings", "rendering settings"],
    "OpenProjectSettings",
    "new op OpenProjectSettings{tab?} over ProjectSettingsEditor::popup_project_settings (needs an EditorNode accessor)"
  ),
  plannedEditor(
    "editor-settings",
    "Editor Settings",
    "The Editor Settings dialog opens.",
    ["editor settings", "settings", "open editor settings", "editor preferences", "change the editor theme"],
    "OpenEditorSettings",
    "new op OpenEditorSettings over EditorSettingsDialog::popup_edit_settings"
  ),
  plannedEditor(
    "output",
    "Output panel",
    "The Output bottom panel opens.",
    ["output panel", "show the output", "editor console", "show the log"],
    "ShowBottomPanel",
    "new op ShowBottomPanel{panel} over EditorBottomPanel::make_item_visible plus a name resolver"
  ),
  plannedEditor(
    "debugger",
    "Debugger panel",
    "The Debugger bottom panel opens.",
    ["debugger panel", "show the debugger", "open the debugger", "errors panel"],
    "ShowBottomPanel",
    "new op ShowBottomPanel{panel} over EditorBottomPanel::make_item_visible plus a name resolver"
  ),
  plannedEditor(
    "editor-window",
    "Summer Engine window",
    "The Summer Engine window comes to the front.",
    ["bring the editor to the front", "focus summer engine", "show the editor window", "switch to the editor"],
    "FocusEditorWindow",
    "new op FocusEditorWindow over DisplayServer::window_move_to_foreground(MAIN_WINDOW_ID); the fork never calls it today"
  ),
  plannedEditor(
    "import-dock",
    "Import dock",
    "The Import dock comes to the front.",
    ["import dock", "import settings panel", "show import options"],
    "FocusDock",
    "extend _se_resolve_dock (ops_executor.cpp) with import, signals, groups, changes and chat dock ids"
  ),
];

const BY_ID = new Map<string, NavTarget>();
for (const target of NAV_TARGETS) {
  if (BY_ID.has(target.id)) throw new Error(`navigation: duplicate target id ${target.id}`);
  BY_ID.set(target.id, target);
  for (const alias of target.aliases ?? []) {
    if (BY_ID.has(alias)) throw new Error(`navigation: alias ${alias} collides on ${target.id}`);
    BY_ID.set(alias, target);
  }
}

export function getNavTarget(idOrAlias: string): NavTarget | undefined {
  return BY_ID.get(idOrAlias.trim().toLowerCase());
}
