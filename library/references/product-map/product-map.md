# Summer product map

> Every place an agent can send the user: pages on summerengine.com and docs.summerengine.com, and surfaces inside the Summer Engine editor. One table, two surfaces. Open any row with `summer_open` (MCP) or `summer open <id>` (CLI); the `navigate-summer` skill says when to open a surface for the user and when to act through the API instead.

## How to read a row

- **id** — what you pass as `target`. Aliases in parentheses also resolve. Intent phrases in the third column resolve too (`summer open "change my plan"`), and `summer open --list` prints this table from the running tool.
- **where** — the URL (web) or the engine op (editor). `{slot}` is a required param; `[/{slot}]` is optional. Web URLs are shown on `https://summerengine.com`; the tool uses the configured gateway (`gateway.url` / `SUMMER_GATEWAY_URL`), so a staging gateway opens staging.
- **params** — slot values passed as `params: { gameId, section, username, version, guide, path, node, scene }`. `guide` accepts an agent name (`cursor`, `claude-code`, `codex`, `gemini`, `cline`, `kilo-code`, `opencode`, `devin`, `windsurf`, `ollama`, `lm-studio`, `goose`, `local-llms`). `section` is one of `overview builds releases store-page passport products achievements players community liveops safety analytics economy developers access audit danger-zone settings`.
- **requires** — `login`: the page needs a Summer account; when this machine has no CLI login token the tool opens `/login?returnUrl=<path>` and the destination loads after sign-in. `engine running`: Summer Engine must be open on the project; otherwise the tool reports `engine_not_running` and nothing opens.
- **status** — `implemented` works today. `planned` resolves and prints but cannot open: the engine has no op for it yet, and the row names the engine change. The tool never pretends a planned target opened.

Things that do not exist and are therefore not in the map (verified against the web app, 2026-09-03): a public play URL for a published game (`/games` is a curated gallery; distribution runs through a game's Builds / Releases / Store page in Studio, so "my published games" is `my-games`), and an API-token or MCP-credential page (CLI login is a device-code flow started by `summer login`).

## The map

| id | surface | intents (excerpt) | where | params | requires | status | what the user sees |
|---|---|---|---|---|---|---|---|
| `home` | web | "summer website", "homepage", "the website", "summerengine.com" | `https://summerengine.com/` | — | — | implemented | The Summer homepage. |
| `pricing` | web | "pricing", "how much does it cost", "plans and prices", "what does summer cost" | `https://summerengine.com/pricing` | — | — | implemented | Free tier and paid AI-usage tiers; upgrade buttons start Stripe checkout. |
| `download` | web | "download the app", "download summer engine", "install summer engine", "get the desktop app" | `https://summerengine.com/download` | — | — | implemented | Desktop installers for macOS and Windows. |
| `cli-guide` | web | "cli page", "how do i install the cli", "cli setup", "command line install" | `https://summerengine.com/cli` | — | — | implemented | How to install the summer-engine CLI and the one-paste agent prompt. |
| `mcp-guide` | web | "mcp setup", "set up the mcp", "connect my agent", "how do i set up cursor" | `https://summerengine.com/mcp[/{guide}]` | `guide` | — | implemented | The MCP + CLI hub, or the step-by-step guide for one agent (Claude Code, Cursor, Codex, Gemini CLI, Cline, Kilo Code, OpenCode, Devin, local LLMs, Ollama, LM Studio, Goose). |
| `templates` | web | "browse templates", "template gallery", "game templates", "starter projects" | `https://summerengine.com/templates` | — | — | implemented | Browse every game template by category and use case. |
| `templates-start` | web | "start a new game on the web", "web onboarding", "plan builder" | `https://summerengine.com/templates/start` | — | — | implemented | The web onboarding flow that turns a template pick into a plan. |
| `asset-store` | web | "asset store", "find assets", "browse assets", "free game assets" | `https://summerengine.com/asset-store` | — | — | implemented | Browse 2D art, 3D models, sprites, animations, music and sound effects. |
| `plugins` | web | "plugins", "plugin catalog", "skills catalog" | `https://summerengine.com/plugins` | — | — | implemented | The public plugin and skill catalog. |
| `changelog` | web | "changelog", "what's new", "release notes", "what changed in the last update" | `https://summerengine.com/changelog[/{version}]` | `version` | — | implemented | Release notes — the index, or one engine version. |
| `blog` | web | "blog", "blog posts", "articles" | `https://summerengine.com/blog` | — | — | implemented | The Summer blog. |
| `roadmap` | web | "roadmap", "what's coming", "planned features" | `https://summerengine.com/roadmap` | — | — | implemented | The public product roadmap. |
| `games` | web | "games gallery", "featured games", "game jams", "jam" | `https://summerengine.com/games` | — | — | implemented | The public gallery of featured games, jams and events. |
| `docs` | web | "documentation", "the docs", "read the docs", "manual" | `https://docs.summerengine.com/` | — | — | implemented | docs.summerengine.com — the Summer documentation. |
| `docs-mcp` | web | "mcp docs", "mcp documentation", "how the mcp works" | `https://docs.summerengine.com/mcp/overview` | — | — | implemented | The MCP overview in the documentation. |
| `docs-install` | web | "installation docs", "install instructions", "how to install" | `https://docs.summerengine.com/essentials/installation` | — | — | implemented | Installing Summer Engine, step by step. |
| `docs-quickstart` | web | "quickstart", "getting started guide", "first project tutorial" | `https://docs.summerengine.com/quickstarts/fresh-project` | — | — | implemented | Fresh-project quickstart in the documentation. |
| `docs-sdk` | web | "sdk reference", "sdk docs", "api reference", "summer sdk" | `https://docs.summerengine.com/api-reference/summer-sdk` | — | — | implemented | The Summer SDK API reference. |
| `login` | web | "sign in", "log in", "login page" | `https://summerengine.com/login` | — | — | implemented | The sign-in page (email/password or Google). |
| `signup` | web | "sign up", "create an account", "register" | `https://summerengine.com/signup` | — | — | implemented | The sign-up page. |
| `studio` | web | "studio", "summer studio", "open studio", "the studio" | `https://summerengine.com/studio` | — | — | implemented | The Studio workspace (home tab). |
| `my-games` (`projects`, `my-projects`, `published-games`) | web | "my games", "my projects", "my published games", "published games" | `https://summerengine.com/studio/games` | — | login | implemented | Your games (projects) in Studio: overview, builds, releases, store pages. |
| `game` | web | "open this game in studio", "builds for my game", "releases of my game", "store page for my game" | `https://summerengine.com/studio/games/{gameId}[/{section}]` | `gameId` (required), `section` | login | implemented | One game's Studio pages: overview, builds, releases, store page, passport, players, analytics, economy, settings, danger zone and more. |
| `billing` (`plan`, `subscription`, `payments`) | web | "billing", "change my plan", "upgrade my plan", "upgrade" | `https://summerengine.com/studio?tab=billing` | — | login | implemented | Current plan, upgrade, Stripe billing portal (payment method, invoices), top-ups. |
| `usage` (`spending`, `credits`) | web | "usage", "how many credits do i have left", "spending", "credit usage" | `https://summerengine.com/studio?tab=billing&section=usage` | — | login | implemented | Account usage and spending — how many credits were used and on what. |
| `account` | web | "my account", "account overview", "account page", "profile settings" | `https://summerengine.com/studio?tab=account` | — | login | implemented | Your account overview in Studio. |
| `settings` | web | "account settings", "settings page", "change my email", "change my password" | `https://summerengine.com/studio?tab=settings` | — | login | implemented | Account settings in Studio (email, password, preferences, delete account). |
| `team` (`members`, `workspace`) | web | "team", "members", "invite a teammate", "workspace members" | `https://summerengine.com/studio?tab=team` | — | login | implemented | Workspace members and invites. |
| `cloud` | web | "project cloud", "cloud storage", "cloud projects", "synced projects" | `https://summerengine.com/studio?tab=cloud` | — | login | implemented | Project Cloud storage and synced projects. |
| `my-assets` (`assets`, `library`) | web | "my assets", "generated assets", "my library", "saved assets" | `https://summerengine.com/studio?tab=assets` | — | — | implemented | Assets you generated or saved, ready to import. |
| `workflows` | web | "guided workflows", "workflows", "studio recipes" | `https://summerengine.com/studio?tab=workflows` | — | — | implemented | Guided Studio workflows (recipes). |
| `story-builder` | web | "story builder", "write my story", "narrative tool" | `https://summerengine.com/studio?tab=storyBuilder` | — | login | implemented | The Story Builder tool. |
| `board` | web | "board", "task board", "kanban" | `https://summerengine.com/studio?tab=board` | — | login | implemented | The project board. |
| `studio-plugins` | web | "plugins in studio", "manage my plugins", "installed plugins" | `https://summerengine.com/studio?tab=plugins` | — | — | implemented | Plugins tab inside Studio. |
| `studio-store` | web | "asset store in studio", "store tab" | `https://summerengine.com/studio?tab=store` | — | — | implemented | The Asset Store as a Studio tab. |
| `generate-image` (`2d`, `image`) | web | "image generator", "generate an image on the web", "2d tab", "make a picture in studio" | `https://summerengine.com/studio?tab=image` | — | — | implemented | Generate or edit images (the 2D tab). |
| `generate-3d` (`3d`) | web | "3d generator", "generate a 3d model on the web", "3d tab" | `https://summerengine.com/studio?tab=3d` | — | — | implemented | Generate 3D models (the 3D tab). |
| `generate-audio` (`audio`) | web | "audio generator", "generate audio on the web", "audio tab", "music generator" | `https://summerengine.com/studio?tab=audio` | — | — | implemented | Generate speech, music and sound effects. |
| `generate-video` (`video`) | web | "video generator", "generate a video on the web", "video tab" | `https://summerengine.com/studio?tab=video` | — | — | implemented | Generate video (the Video tab). |
| `generate-animation` (`animation`) | web | "animation tab", "animation tools", "retarget on the web", "upload a mocap clip" | `https://summerengine.com/studio?tab=animation` | — | — | implemented | Animation tools (retargeting, mocap uploads). |
| `chat` | web | "web chat", "chat on the website", "summer chat" | `https://summerengine.com/chat` | — | login | implemented | A new agent chat on the web. |
| `skills` | web | "my skills page", "edit my skills on the web", "skills editor" | `https://summerengine.com/skills` | — | login | implemented | The agent-skills editor on the web. |
| `profile` | web | "my public profile", "public profile of", "creator page", "see my profile" | `https://summerengine.com/{username}` | `username` (required) | — | implemented | A creator's public profile page. |
| `edit-profile` | web | "edit my profile", "change my avatar", "update my bio", "profile editor" | `https://summerengine.com/profile/edit` | — | login | implemented | Edit your public profile. |
| `submit-game` | web | "submit my game", "add my game to the gallery", "enter the jam", "submit to the jam" | `https://summerengine.com/games/create` | — | login | implemented | Submit a game to the public gallery or a jam. |
| `scene` | editor | "open the scene", "open this scene", "show the scene", "switch to the scene" | `OpenScene path=<path> (path defaults to the main scene)` | `path` | engine running | implemented | The scene becomes the current tab in Summer Engine. |
| `main-scene` | editor | "open the main scene", "main scene", "go to the main scene", "the starting scene" | `OpenScene (path defaults to the main scene)` | — | engine running | implemented | The project's configured main scene becomes the current tab. |
| `node` | editor | "select the node", "show me the node", "focus the player node", "highlight the node" | `SelectNode nodePath=<node> scenePath=<scene>` | `node` (required), `scene` | engine running | implemented | The node is highlighted in the Scene tree and its properties show in the Inspector. |
| `script` | editor | "open the script", "show me the script", "open the gdscript file", "go to the script" | `OpenResource path=<path>` | `path` (required) | engine running | implemented | The script opens in the Script editor (the engine does not steal focus from where the user is typing). |
| `file` | editor | "show the file in the filesystem", "reveal the file", "find the file in the editor", "where is this asset" | `RevealInFileSystem path=<path>` | `path` (required) | engine running | implemented | The FileSystem dock comes to the front, scrolled to the file. |
| `files` (`filesystem`, `file-system`) | editor | "filesystem dock", "file dock", "show the files", "project files panel" | `FocusDock {"dock":"file_system"}` | — | engine running | implemented | The FileSystem dock comes to the front. |
| `scene-tree` | editor | "scene tree", "scene dock", "show the scene tree", "node tree panel" | `FocusDock {"dock":"scene_tree"}` | — | engine running | implemented | The Scene tree dock comes to the front. |
| `inspector` | editor | "inspector", "show the inspector", "properties panel", "inspector dock" | `FocusDock {"dock":"inspector"}` | — | engine running | implemented | The Inspector dock comes to the front. |
| `screen-2d` | editor | "switch to 2d", "2d view", "show the 2d editor" | `SetMainScreen` | — | engine running | planned — new op SetMainScreen{screen} calling EditorInterface::set_main_screen_editor (exists only behind the chat webview bridge editor:show-viewport) | The main editor switches to the 2D view. |
| `screen-3d` | editor | "switch to 3d", "3d view", "show the 3d editor", "show me the viewport" | `SetMainScreen` | — | engine running | planned — new op SetMainScreen{screen} calling EditorInterface::set_main_screen_editor | The main editor switches to the 3D view. |
| `screen-script` | editor | "switch to the script editor", "script view", "show the code editor" | `SetMainScreen` | — | engine running | planned — new op SetMainScreen{screen} calling EditorInterface::set_main_screen_editor; fallback `script` | The main editor switches to the Script editor. |
| `screen-game` | editor | "switch to the game view", "game tab", "show the running game view" | `SetMainScreen` | — | engine running | planned — new op SetMainScreen{screen} calling EditorInterface::set_main_screen_editor | The main editor switches to the Game view. |
| `assistant` | editor | "open the assistant", "show the chat dock", "summer assistant", "ai chat in the editor" | `FocusChat` | — | engine running | planned — new op FocusChat{path?} over ChatDock::open_chat_path (today only the chat:open webview bridge message) | The Summer assistant (chat) dock opens. |
| `project-settings` | editor | "project settings", "open project settings", "input map settings", "autoload settings" | `OpenProjectSettings` | — | engine running | planned — new op OpenProjectSettings{tab?} over ProjectSettingsEditor::popup_project_settings (needs an EditorNode accessor) | The Project Settings dialog opens. |
| `editor-settings` | editor | "editor settings", "open editor settings", "editor preferences", "change the editor theme" | `OpenEditorSettings` | — | engine running | planned — new op OpenEditorSettings over EditorSettingsDialog::popup_edit_settings | The Editor Settings dialog opens. |
| `output` | editor | "output panel", "show the output", "editor console", "show the log" | `ShowBottomPanel` | — | engine running | planned — new op ShowBottomPanel{panel} over EditorBottomPanel::make_item_visible plus a name resolver | The Output bottom panel opens. |
| `debugger` | editor | "debugger panel", "show the debugger", "open the debugger", "errors panel" | `ShowBottomPanel` | — | engine running | planned — new op ShowBottomPanel{panel} over EditorBottomPanel::make_item_visible plus a name resolver | The Debugger bottom panel opens. |
| `editor-window` | editor | "bring the editor to the front", "focus summer engine", "show the editor window", "switch to the editor" | `FocusEditorWindow` | — | engine running | planned — new op FocusEditorWindow over DisplayServer::window_move_to_foreground(MAIN_WINDOW_ID); the fork never calls it today | The Summer Engine window comes to the front. |
| `import-dock` | editor | "import dock", "import settings panel", "show import options" | `FocusDock` | — | engine running | planned — extend _se_resolve_dock (ops_executor.cpp) with import, signals, groups, changes and chat dock ids | The Import dock comes to the front. |

## Shorthands the tool also accepts

- A `res://` path: `.tscn`/`.scn` → `scene`, `.gd`/`.cs` → `script`, anything else → `file`.
- A summerengine.com path: `/pricing` resolves to the matching row; an unknown path on the gateway origin opens as given and is reported `unmapped: true`.
- Anything that is not on summerengine.com or docs.summerengine.com is refused.

## Verification and drift

Web rows were verified against the web app's route files on 2026-09-03 (Studio `?tab=` list and its login-required tabs, the selected-game section segments, the MCP guide slugs, the `/login?returnUrl=` redirect). Editor rows were verified against the engine's op registry (OpenScene, SelectNode, OpenResource, FocusDock with exactly the dock ids `file_system | scene_tree | inspector`, RevealInFileSystem). The table is rendered from the tool's own target list; a test fails when the two disagree on ids, so this page and `summer open --list` cannot drift apart.
