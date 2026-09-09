/**
 * The product map as the toolkit sees it (docs/design/NAVIGATION-PLAN.md).
 *
 * The toolkit does NOT own where things are. Each product does:
 *
 * - summerengine.com publishes /agent-routes.json (web repo
 *   src/lib/navigation/routes.ts). A vendored snapshot lives at
 *   assets/navigation/web-routes.json (refresh: `npm run sync:web-routes`) and
 *   every web row below is built from it — nothing hand-written.
 * - Summer Engine owns one table of editor destinations (navigate_ops.cpp) and
 *   advertises the ids it can open in /api/health capabilities.navigation.
 *   The rows below are METADATA for those ids (titles, intents, argument
 *   names) plus, for the few ids an older engine can serve through its
 *   original ops, a `legacy` mapping. Availability is decided at connect time
 *   from the advert, never hardcoded here.
 *
 * `summer_open` / `summer open` forward ids; they never know the layout.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_ROOT } from "../../package-root.js";

export type NavSurface = "web" | "editor";

export interface NavParam {
  name: string;
  description: string;
  required?: boolean;
  /** Closed vocabulary, when one exists (validated). */
  values?: readonly string[];
  /** Friendly names that resolve to a value in `values` (e.g. "cursor" -> a guide slug). */
  valueAliases?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Web: the vendored /agent-routes.json snapshot
// ---------------------------------------------------------------------------

export interface WebRoute {
  id: string;
  /** Path template. `{slot}` required; `[/{slot}]` optional segment. */
  path: string;
  title: string;
  description: string;
  intents: readonly string[];
  auth: "public" | "signed-in";
  aliases?: readonly string[];
  params?: readonly NavParam[];
  /** "docs" = docs.summerengine.com; default = the gateway origin. */
  origin?: "web" | "docs";
}

export interface WebRoutesCatalog {
  schemaVersion: string;
  source?: string;
  base: string;
  docsBase: string;
  login: { path: string; returnParam: string };
  routes: WebRoute[];
}

export const WEB_ROUTES_SNAPSHOT_PATH = resolve(PACKAGE_ROOT, "assets/navigation/web-routes.json");

export function parseWebRoutesCatalog(raw: unknown, where = "web-routes"): WebRoutesCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: not an object`);
  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc.routes)) throw new Error(`${where}: missing routes[]`);
  const login = (doc.login ?? {}) as Record<string, unknown>;
  const routes: WebRoute[] = [];
  const seen = new Set<string>();
  for (const entry of doc.routes) {
    const r = (entry ?? {}) as Record<string, unknown>;
    for (const key of ["id", "path", "title", "description"]) {
      if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
        throw new Error(`${where}: route ${JSON.stringify(r.id ?? "?")} missing string ${key}`);
      }
    }
    if (seen.has(r.id as string)) throw new Error(`${where}: duplicate route id ${r.id as string}`);
    seen.add(r.id as string);
    routes.push({
      id: r.id as string,
      path: r.path as string,
      title: r.title as string,
      description: r.description as string,
      intents: Array.isArray(r.intents) ? (r.intents as unknown[]).filter((x): x is string => typeof x === "string") : [],
      auth: r.auth === "signed-in" ? "signed-in" : "public",
      ...(Array.isArray(r.aliases) ? { aliases: (r.aliases as unknown[]).filter((x): x is string => typeof x === "string") } : {}),
      ...(Array.isArray(r.params) ? { params: r.params as NavParam[] } : {}),
      ...(r.origin === "docs" ? { origin: "docs" as const } : {}),
    });
  }
  return {
    schemaVersion: typeof doc.schemaVersion === "string" ? doc.schemaVersion : "1.0",
    ...(typeof doc.source === "string" ? { source: doc.source } : {}),
    base: typeof doc.base === "string" ? doc.base : "https://www.summerengine.com",
    docsBase: typeof doc.docsBase === "string" ? doc.docsBase : "https://docs.summerengine.com",
    login: {
      path: typeof login.path === "string" ? login.path : "/login",
      returnParam: typeof login.returnParam === "string" ? login.returnParam : "returnUrl",
    },
    routes,
  };
}

export function loadWebRoutesCatalog(path = WEB_ROUTES_SNAPSHOT_PATH): WebRoutesCatalog {
  return parseWebRoutesCatalog(JSON.parse(readFileSync(path, "utf8")), path);
}

export const WEB_CATALOG: WebRoutesCatalog = loadWebRoutesCatalog();

// ---------------------------------------------------------------------------
// Editor: metadata for the engine's navigation ids
// ---------------------------------------------------------------------------

/** How to express a row as the engine's one-table op: Navigate { target, ...args }. */
export interface NavigateSpec {
  target: string;
  fixed?: Readonly<Record<string, string>>;
  /** param name -> Navigate arg name */
  map?: Readonly<Record<string, string>>;
}

/** The pre-Navigate op an older engine can serve this row with. */
export interface LegacyOpSpec {
  op: string;
  fixed?: Readonly<Record<string, string>>;
  /** param name -> op field */
  map?: Readonly<Record<string, string>>;
}

export interface EditorTargetMeta {
  id: string;
  title: string;
  description: string;
  intents: readonly string[];
  aliases?: readonly string[];
  navigate: NavigateSpec;
  legacy?: LegacyOpSpec;
  params?: readonly NavParam[];
  /** When `path` is omitted, read application/run/main_scene first. */
  mainSceneDefault?: boolean;
}

const PATH_PARAM: NavParam = { name: "path", description: "Project resource path, e.g. res://levels/level_1.tscn", required: true };

function dock(id: string, name: string, title: string, intents: string[], legacyDock?: string, aliases?: string[]): EditorTargetMeta {
  return {
    id,
    title,
    description: `The ${title} comes to the front.`,
    intents,
    ...(aliases ? { aliases } : {}),
    navigate: { target: "dock", fixed: { name } },
    ...(legacyDock ? { legacy: { op: "FocusDock", fixed: { dock: legacyDock } } } : {}),
  };
}

function screen(id: string, name: string, intents: string[]): EditorTargetMeta {
  return {
    id,
    title: `${name} main screen`,
    description: `The main editor switches to the ${name} view.`,
    intents,
    navigate: { target: id },
  };
}

function panel(id: string, title: string, intents: string[]): EditorTargetMeta {
  return {
    id,
    title,
    description: `The ${title} opens at the bottom of the editor.`,
    intents,
    navigate: { target: "panel", fixed: { name: id } },
  };
}

export const EDITOR_TARGETS: readonly EditorTargetMeta[] = [
  {
    id: "scene",
    title: "Open a scene",
    description: "The scene becomes the current tab in Summer Engine.",
    intents: ["open the scene", "open this scene", "show the scene", "switch to the scene", "the scene i'm editing", "open my level"],
    navigate: { target: "scene", map: { path: "path" } },
    legacy: { op: "OpenScene", map: { path: "path" } },
    params: [{ name: "path", description: "Scene path, e.g. res://main.tscn. Omit for the project's main scene." }],
    mainSceneDefault: true,
  },
  {
    id: "main-scene",
    title: "Open the main scene",
    description: "The project's configured main scene becomes the current tab.",
    intents: ["open the main scene", "main scene", "go to the main scene", "the starting scene"],
    navigate: { target: "scene" },
    legacy: { op: "OpenScene" },
    mainSceneDefault: true,
  },
  {
    id: "node",
    title: "Select a node",
    description: "The node is highlighted in the Scene tree and its properties show in the Inspector.",
    intents: ["select the node", "show me the node", "focus the player node", "highlight the node", "go to the node", "inspect the node in the editor"],
    navigate: { target: "node", map: { node: "path", scene: "scene" } },
    legacy: { op: "SelectNode", map: { node: "nodePath", scene: "scenePath" } },
    params: [
      { name: "node", description: "Node path relative to the scene root, e.g. Player/Camera3D.", required: true },
      { name: "scene", description: "Scene to open first, e.g. res://main.tscn (optional)." },
    ],
  },
  {
    id: "script",
    title: "Open a script",
    description: "The script opens in the Script editor and takes focus (at a line, when given). On engines without the Navigate op it opens without taking focus.",
    intents: ["open the script", "show me the script", "open the gdscript file", "go to the script", "open player.gd", "jump to line"],
    navigate: { target: "script", map: { path: "path", line: "line", col: "col" } },
    legacy: { op: "OpenResource", map: { path: "path" } },
    params: [PATH_PARAM, { name: "line", description: "1-based line to jump to (Navigate engines only)." }, { name: "col", description: "Column (Navigate engines only)." }],
  },
  {
    id: "file",
    title: "Reveal a file",
    description: "The FileSystem dock comes to the front, scrolled to the file.",
    intents: ["show the file in the filesystem", "reveal the file", "find the file in the editor", "where is this asset", "show me the texture in the file dock"],
    navigate: { target: "file", map: { path: "path" } },
    legacy: { op: "RevealInFileSystem", map: { path: "path" } },
    params: [PATH_PARAM],
  },
  dock("files", "file_system", "FileSystem dock", ["filesystem dock", "file dock", "show the files", "project files panel"], "file_system", ["filesystem", "file-system"]),
  dock("scene-tree", "scene_tree", "Scene tree dock", ["scene tree", "scene dock", "show the scene tree", "node tree panel"], "scene_tree"),
  dock("inspector", "inspector", "Inspector dock", ["inspector", "show the inspector", "properties panel", "inspector dock"], "inspector"),
  dock("import-dock", "import", "Import dock", ["import dock", "import settings panel", "show import options"]),
  dock("signals-dock", "node", "Node dock (signals and groups)", ["signals dock", "node dock", "show the signals", "connect signals panel"]),
  dock("changes-dock", "changes", "Changes dock", ["changes dock", "show the changes", "what did the agent change", "diff panel"]),
  screen("screen-2d", "2D", ["switch to 2d", "2d view", "show the 2d editor"]),
  screen("screen-3d", "3D", ["switch to 3d", "3d view", "show the 3d editor", "show me the viewport"]),
  screen("screen-script", "Script", ["switch to the script editor", "script view", "show the code editor"]),
  screen("screen-game", "Game", ["switch to the game view", "game tab", "show the running game view"]),
  screen("screen-assetlib", "AssetLib", ["asset library tab", "open the asset lib", "godot asset library"]),
  {
    id: "viewport-show",
    title: "Show the viewport column",
    description: "The agent layout's viewport column becomes visible.",
    intents: ["show the viewport column", "bring back the viewport", "unhide the editor viewport"],
    navigate: { target: "viewport-show" },
  },
  {
    id: "viewport-hide",
    title: "Hide the viewport column",
    description: "The agent layout's viewport column is hidden.",
    intents: ["hide the viewport column", "hide the editor viewport", "chat only layout"],
    navigate: { target: "viewport-hide" },
  },
  {
    id: "assistant",
    title: "Summer assistant",
    description: "The Summer assistant (chat) dock opens.",
    intents: ["open the assistant", "show the chat dock", "summer assistant", "ai chat in the editor", "open the agent panel"],
    navigate: { target: "assistant", map: { path: "path" } },
    params: [{ name: "path", description: "Chat path to open (optional)." }],
  },
  {
    id: "project-settings",
    title: "Project Settings",
    description: "The Project Settings dialog opens.",
    intents: ["project settings", "settings", "open project settings", "input map settings", "autoload settings", "rendering settings"],
    navigate: { target: "project-settings", map: { tab: "tab" } },
    params: [{ name: "tab", description: "Settings tab to show (best effort)." }],
  },
  {
    id: "editor-settings",
    title: "Editor Settings",
    description: "The Editor Settings dialog opens.",
    intents: ["editor settings", "settings", "open editor settings", "editor preferences", "change the editor theme"],
    navigate: { target: "editor-settings" },
  },
  panel("output", "Output panel", ["output panel", "show the output", "editor console", "show the log"]),
  panel("debugger", "Debugger panel", ["debugger panel", "show the debugger", "open the debugger", "errors panel"]),
  {
    id: "editor-window",
    title: "Summer Engine window",
    description: "The Summer Engine window comes to the front.",
    intents: ["bring the editor to the front", "focus summer engine", "show the editor window", "switch to the editor"],
    navigate: { target: "editor-window" },
  },
];

/** Legacy ops the toolkit may still send on engines that predate `Navigate`. */
export const LEGACY_NAVIGATION_OPS = new Set(["OpenScene", "SelectNode", "OpenResource", "FocusDock", "RevealInFileSystem"]);

// ---------------------------------------------------------------------------
// Unified view for matching
// ---------------------------------------------------------------------------

export interface NavTarget {
  id: string;
  surface: NavSurface;
  title: string;
  description: string;
  intents: readonly string[];
  aliases?: readonly string[];
  params?: readonly NavParam[];
  requires: { login?: boolean; engine?: boolean };
  web?: { origin: "gateway" | "docs"; path: string };
  editor?: EditorTargetMeta;
}

function fromWeb(route: WebRoute): NavTarget {
  return {
    id: route.id,
    surface: "web",
    title: route.title,
    description: route.description,
    intents: route.intents,
    ...(route.aliases ? { aliases: route.aliases } : {}),
    ...(route.params ? { params: route.params } : {}),
    requires: route.auth === "signed-in" ? { login: true } : {},
    web: { origin: route.origin === "docs" ? "docs" : "gateway", path: route.path },
  };
}

function fromEditor(meta: EditorTargetMeta): NavTarget {
  return {
    id: meta.id,
    surface: "editor",
    title: meta.title,
    description: meta.description,
    intents: meta.intents,
    ...(meta.aliases ? { aliases: meta.aliases } : {}),
    ...(meta.params ? { params: meta.params } : {}),
    requires: { engine: true },
    editor: meta,
  };
}

export const NAV_TARGETS: readonly NavTarget[] = [...WEB_CATALOG.routes.map(fromWeb), ...EDITOR_TARGETS.map(fromEditor)];

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
