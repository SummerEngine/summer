# Summer product map

> Every place an agent can send the user: pages on summerengine.com and docs.summerengine.com, and surfaces inside the Summer Engine editor. One table, two surfaces. Open any row with `summer_open` (MCP) or `summer open <id>` (CLI); the `navigate-summer` skill says when to open a surface for the user and when to act through the API instead.

**Generated file.** Rendered from the tool's own data by `node scripts/navigation/render-product-map.ts`; a test fails when this file and the data disagree. Do not edit by hand.

## Who owns what

- **Web rows** come from summerengine.com's own route catalog (`/agent-routes.json`, published from the web repo's `src/lib/navigation/routes.ts`). The toolkit vendors a snapshot (`assets/navigation/web-routes.json`, refreshed with `npm run sync:web-routes`); it does not invent pages.
- **Editor rows** are ids of Summer Engine's one navigation table (`navigate_ops.cpp`, op `Navigate`). The running engine advertises which ids it can open in `/api/health` `capabilities.navigation`; `summer open --list` shows availability from the connected engine. Engines that predate the `Navigate` op can still serve the rows with a legacy op (last-but-one column); every other row answers `engine_lacks_op` with an update hint.

## How to read a row

- **id** — what you pass as `target`. Aliases in parentheses also resolve. Intent phrases in the third column resolve too (`summer open "change my plan"`).
- **where** — the URL (web) or the engine op (editor). `{slot}` is a required param; `[/{slot}]` is optional. Web URLs are shown on the apex host; the tool uses the configured gateway (`gateway.url` / `SUMMER_GATEWAY_URL`), so a staging gateway opens staging.
- **params** — slot values passed as `params: { … }`. `guide` accepts an agent name (`cursor`, `claude-code`, `codex`, `gemini`, …) or a guide slug; `section` is one of the game's Studio sections; `line`/`col` are for `script`.
- **login** — the page needs a Summer account; when this machine has no CLI login token the tool opens `/login?returnUrl=<path>` and the destination loads after sign-in. Editor rows need Summer Engine running with the project open; otherwise the tool reports `engine_not_running` and nothing opens.

Things that do not exist and are therefore not in the map (verified against the web app, 2026-09-03): a public play URL for a published game (`/games` is a curated gallery; distribution runs through a game's Builds / Releases / Store page in Studio, so "my published games" is `my-games`), and an API-token or MCP-credential page (CLI login is a device-code flow started by `summer login`).

## Web

| id | surface | intents (excerpt) | where | params | login | what the user sees |
|---|---|---|---|---|---|---|
| `home` | web | "summer website", "homepage", "the website", "summerengine.com" | `https://summerengine.com/` | — | — | The Summer homepage. |
| `pricing` | web | "pricing", "how much does it cost", "plans and prices", "what does summer cost" | `https://summerengine.com/pricing` | — | — | Free tier and paid AI-usage tiers; upgrade buttons start Stripe checkout. |
| `download` | web | "download the app", "download summer engine", "install summer engine", "get the desktop app" | `https://summerengine.com/download` | — | — | Desktop installers for macOS and Windows. |
| `cli-guide` | web | "cli page", "how do i install the cli", "cli setup", "command line install" | `https://summerengine.com/cli` | — | — | How to install the summer-engine CLI and the one-paste agent prompt. |
| `mcp-guide` | web | "mcp setup", "set up the mcp", "connect my agent", "how do i set up cursor" | `https://summerengine.com/mcp[/{guide}]` | `guide` | — | The MCP + CLI hub, or the step-by-step guide for one agent (Claude Code, Cursor, Codex, Gemini CLI, Cline, Kilo Code, OpenCode, Devin, local LLMs, Ollama, LM Studio, Goose). |
| `templates` | web | "browse templates", "template gallery", "game templates", "starter projects" | `https://summerengine.com/templates` | — | — | Browse every game template by category and use case. |
| `templates-start` | web | "start a new game on the web", "web onboarding", "plan builder" | `https://summerengine.com/templates/start` | — | — | The web onboarding flow that turns a template pick into a plan. |
| `asset-store` | web | "asset store", "find assets", "browse assets", "free game assets" | `https://summerengine.com/asset-store` | — | — | Browse 2D art, 3D models, sprites, animations, music and sound effects. |
| `plugins` | web | "plugins", "plugin catalog", "skills catalog" | `https://summerengine.com/plugins` | — | — | The public plugin and skill catalog. |
| `changelog` | web | "changelog", "what's new", "release notes", "what changed in the last update" | `https://summerengine.com/changelog[/{version}]` | `version` | — | Release notes: the index, or one engine version. |
| `blog` | web | "blog", "blog posts", "articles" | `https://summerengine.com/blog` | — | — | The Summer blog. |
| `roadmap` | web | "roadmap", "what's coming", "planned features" | `https://summerengine.com/roadmap` | — | — | The public product roadmap. |
| `games` | web | "games gallery", "featured games", "game jams", "jam" | `https://summerengine.com/games` | — | — | The public gallery of featured games, jams and events. |
| `docs` | web | "documentation", "the docs", "read the docs", "manual" | `https://docs.summerengine.com/` | — | — | docs.summerengine.com, the Summer documentation. |
| `docs-mcp` | web | "mcp docs", "mcp documentation", "how the mcp works" | `https://docs.summerengine.com/mcp/overview` | — | — | The MCP overview in the documentation. |
| `docs-install` | web | "installation docs", "install instructions", "how to install" | `https://docs.summerengine.com/essentials/installation` | — | — | Installing Summer Engine, step by step. |
| `docs-quickstart` | web | "quickstart", "getting started guide", "first project tutorial" | `https://docs.summerengine.com/quickstarts/fresh-project` | — | — | Fresh-project quickstart in the documentation. |
| `docs-sdk` | web | "sdk reference", "sdk docs", "api reference", "summer sdk" | `https://docs.summerengine.com/api-reference/summer-sdk` | — | — | The Summer SDK API reference. |
| `login` | web | "sign in", "log in", "login page" | `https://summerengine.com/login` | — | — | The sign-in page (email/password or Google). |
| `signup` | web | "sign up", "create an account", "register" | `https://summerengine.com/signup` | — | — | The sign-up page. |
| `studio` | web | "studio", "summer studio", "open studio", "the studio" | `https://summerengine.com/studio` | — | — | The Studio workspace (home tab). |
| `my-games` (`projects`, `my-projects`, `published-games`) | web | "my games", "my projects", "my published games", "published games" | `https://summerengine.com/studio/games` | — | login | Your games (projects) in Studio: overview, builds, releases, store pages. |
| `game` | web | "open this game in studio", "builds for my game", "releases of my game", "store page for my game" | `https://summerengine.com/studio/games/{gameId}[/{section}]` | `gameId` (required), `section` | login | One game's Studio pages: overview, builds, releases, store page, passport, players, analytics, economy, settings, danger zone and more. |
| `billing` (`plan`, `subscription`, `payments`) | web | "billing", "change my plan", "upgrade my plan", "upgrade" | `https://summerengine.com/studio?tab=billing` | — | login | Current plan, upgrade, Stripe billing portal (payment method, invoices), top-ups. |
| `usage` (`spending`, `credits`) | web | "usage", "how many credits do i have left", "spending", "credit usage" | `https://summerengine.com/studio?tab=billing&section=usage` | — | login | Account usage and spending: how many credits were used and on what. |
| `account` | web | "my account", "account overview", "account page", "profile settings" | `https://summerengine.com/studio?tab=account` | — | login | Your account overview in Studio. |
| `settings` | web | "account settings", "settings page", "change my email", "change my password" | `https://summerengine.com/studio?tab=settings` | — | login | Account settings in Studio (email, password, preferences, delete account). |
| `team` (`members`, `workspace`) | web | "team", "members", "invite a teammate", "workspace members" | `https://summerengine.com/studio?tab=team` | — | login | Workspace members and invites. |
| `cloud` | web | "project cloud", "cloud storage", "cloud projects", "synced projects" | `https://summerengine.com/studio?tab=cloud` | — | login | Project Cloud storage and synced projects. |
| `my-assets` (`assets`, `library`) | web | "my assets", "generated assets", "my library", "saved assets" | `https://summerengine.com/studio?tab=assets` | — | — | Assets you generated or saved, ready to import. |
| `workflows` | web | "guided workflows", "workflows", "studio recipes" | `https://summerengine.com/studio?tab=workflows` | — | — | Guided Studio workflows (recipes). |
| `story-builder` | web | "story builder", "write my story", "narrative tool" | `https://summerengine.com/studio?tab=storyBuilder` | — | login | The Story Builder tool. |
| `board` | web | "board", "task board", "kanban" | `https://summerengine.com/studio?tab=board` | — | login | The project board. |
| `studio-plugins` | web | "plugins in studio", "manage my plugins", "installed plugins" | `https://summerengine.com/studio?tab=plugins` | — | — | Plugins tab inside Studio. |
| `studio-store` | web | "asset store in studio", "store tab" | `https://summerengine.com/studio?tab=store` | — | — | The Asset Store as a Studio tab. |
| `generate-image` (`2d`, `image`) | web | "image generator", "generate an image on the web", "2d tab", "make a picture in studio" | `https://summerengine.com/studio?tab=image` | — | — | Generate or edit images (the 2D tab). |
| `generate-3d` (`3d`) | web | "3d generator", "generate a 3d model on the web", "3d tab" | `https://summerengine.com/studio?tab=3d` | — | — | Generate 3D models (the 3D tab). |
| `generate-audio` (`audio`) | web | "audio generator", "generate audio on the web", "audio tab", "music generator" | `https://summerengine.com/studio?tab=audio` | — | — | Generate speech, music and sound effects. |
| `generate-video` (`video`) | web | "video generator", "generate a video on the web", "video tab" | `https://summerengine.com/studio?tab=video` | — | — | Generate video (the Video tab). |
| `generate-animation` (`animation`) | web | "animation tab", "animation tools", "retarget on the web", "upload a mocap clip" | `https://summerengine.com/studio?tab=animation` | — | — | Animation tools (retargeting, mocap uploads). |
| `chat` | web | "web chat", "chat on the website", "summer chat" | `https://summerengine.com/chat` | — | login | A new agent chat on the web. |
| `skills` | web | "my skills page", "edit my skills on the web", "skills editor" | `https://summerengine.com/skills` | — | login | The agent-skills editor on the web. |
| `profile` | web | "my public profile", "public profile of", "creator page", "see my profile" | `https://summerengine.com/{username}` | `username` (required) | — | A creator's public profile page. |
| `edit-profile` | web | "edit my profile", "change my avatar", "update my bio", "profile editor" | `https://summerengine.com/profile/edit` | — | login | Edit your public profile. |
| `submit-game` | web | "submit my game", "add my game to the gallery", "enter the jam", "submit to the jam" | `https://summerengine.com/games/create` | — | login | Submit a game to the public gallery or a jam. |

## Editor

| id | surface | intents (excerpt) | where (Navigate op) | params | legacy op (pre-Navigate engines) | what the user sees |
|---|---|---|---|---|---|---|
| `scene` | editor | "open the scene", "open this scene", "show the scene", "switch to the scene" | `Navigate target=scene path=<path> (path defaults to the main scene)` | `path` | `OpenScene` | The scene becomes the current tab in Summer Engine. |
| `main-scene` | editor | "open the main scene", "main scene", "go to the main scene", "the starting scene" | `Navigate target=scene (path defaults to the main scene)` | — | `OpenScene` | The project's configured main scene becomes the current tab. |
| `node` | editor | "select the node", "show me the node", "focus the player node", "highlight the node" | `Navigate target=node path=<node> scene=<scene>` | `node` (required), `scene` | `SelectNode` | The node is highlighted in the Scene tree and its properties show in the Inspector. |
| `script` | editor | "open the script", "show me the script", "open the gdscript file", "go to the script" | `Navigate target=script path=<path> line=<line> col=<col>` | `path` (required), `line`, `col` | `OpenResource` | The script opens in the Script editor and takes focus (at a line, when given). On engines without the Navigate op it opens without taking focus. |
| `file` | editor | "show the file in the filesystem", "reveal the file", "find the file in the editor", "where is this asset" | `Navigate target=file path=<path>` | `path` (required) | `RevealInFileSystem` | The FileSystem dock comes to the front, scrolled to the file. |
| `files` (`filesystem`, `file-system`) | editor | "filesystem dock", "file dock", "show the files", "project files panel" | `Navigate target=dock name=file_system` | — | `FocusDock` {"dock":"file_system"} | The FileSystem dock comes to the front. |
| `scene-tree` | editor | "scene tree", "scene dock", "show the scene tree", "node tree panel" | `Navigate target=dock name=scene_tree` | — | `FocusDock` {"dock":"scene_tree"} | The Scene tree dock comes to the front. |
| `inspector` | editor | "inspector", "show the inspector", "properties panel", "inspector dock" | `Navigate target=dock name=inspector` | — | `FocusDock` {"dock":"inspector"} | The Inspector dock comes to the front. |
| `import-dock` | editor | "import dock", "import settings panel", "show import options" | `Navigate target=dock name=import` | — | — (needs an engine with the Navigate op) | The Import dock comes to the front. |
| `signals-dock` | editor | "signals dock", "node dock", "show the signals", "connect signals panel" | `Navigate target=dock name=node` | — | — (needs an engine with the Navigate op) | The Node dock (signals and groups) comes to the front. |
| `changes-dock` | editor | "changes dock", "show the changes", "what did the agent change", "diff panel" | `Navigate target=dock name=changes` | — | — (needs an engine with the Navigate op) | The Changes dock comes to the front. |
| `screen-2d` | editor | "switch to 2d", "2d view", "show the 2d editor" | `Navigate target=screen-2d` | — | — (needs an engine with the Navigate op) | The main editor switches to the 2D view. |
| `screen-3d` | editor | "switch to 3d", "3d view", "show the 3d editor", "show me the viewport" | `Navigate target=screen-3d` | — | — (needs an engine with the Navigate op) | The main editor switches to the 3D view. |
| `screen-script` | editor | "switch to the script editor", "script view", "show the code editor" | `Navigate target=screen-script` | — | — (needs an engine with the Navigate op) | The main editor switches to the Script view. |
| `screen-game` | editor | "switch to the game view", "game tab", "show the running game view" | `Navigate target=screen-game` | — | — (needs an engine with the Navigate op) | The main editor switches to the Game view. |
| `screen-assetlib` | editor | "asset library tab", "open the asset lib", "godot asset library" | `Navigate target=screen-assetlib` | — | — (needs an engine with the Navigate op) | The main editor switches to the AssetLib view. |
| `viewport-show` | editor | "show the viewport column", "bring back the viewport", "unhide the editor viewport" | `Navigate target=viewport-show` | — | — (needs an engine with the Navigate op) | The agent layout's viewport column becomes visible. |
| `viewport-hide` | editor | "hide the viewport column", "hide the editor viewport", "chat only layout" | `Navigate target=viewport-hide` | — | — (needs an engine with the Navigate op) | The agent layout's viewport column is hidden. |
| `assistant` | editor | "open the assistant", "show the chat dock", "summer assistant", "ai chat in the editor" | `Navigate target=assistant path=<path>` | `path` | — (needs an engine with the Navigate op) | The Summer assistant (chat) dock opens. |
| `project-settings` | editor | "project settings", "settings", "open project settings", "input map settings" | `Navigate target=project-settings tab=<tab>` | `tab` | — (needs an engine with the Navigate op) | The Project Settings dialog opens. |
| `editor-settings` | editor | "editor settings", "settings", "open editor settings", "editor preferences" | `Navigate target=editor-settings` | — | — (needs an engine with the Navigate op) | The Editor Settings dialog opens. |
| `output` | editor | "output panel", "show the output", "editor console", "show the log" | `Navigate target=panel name=output` | — | — (needs an engine with the Navigate op) | The Output panel opens at the bottom of the editor. |
| `debugger` | editor | "debugger panel", "show the debugger", "open the debugger", "errors panel" | `Navigate target=panel name=debugger` | — | — (needs an engine with the Navigate op) | The Debugger panel opens at the bottom of the editor. |
| `editor-window` | editor | "bring the editor to the front", "focus summer engine", "show the editor window", "switch to the editor" | `Navigate target=editor-window` | — | — (needs an engine with the Navigate op) | The Summer Engine window comes to the front. |

## Shorthands the tool also accepts

- A `res://` path: `.tscn`/`.scn` → `scene`, `.gd`/`.cs` → `script`, anything else → `file`.
- A summerengine.com path: `/pricing` resolves to the matching row; an unknown path on the gateway origin opens as given and is reported `unmapped: true`.
- Anything that is not on summerengine.com or docs.summerengine.com is refused.
