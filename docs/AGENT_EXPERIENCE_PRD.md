# Summer Agent Kit PRD

Status: Draft source of truth for the MCP/CLI rebuild
Date: 2026-05-05
Owner: Summer Engine

This document supersedes the older MCP product, business, and pricing strategy docs until those are rewritten. The existing implementation is useful scaffolding, but it was not tested deeply enough with real daily agent workflows. This PRD optimizes for the best user and AI-agent experience first; monetization is a consequence of where real cost and durable product value exist.

## One Sentence

Summer Agent Kit makes Summer the easiest game engine for Codex, Claude Code, Cursor, and other agents to build in every day: the CLI gets the human set up, MCP gives the agent live engine hands, and Summer Pro sells the managed production cockpit around that workflow.

## Problem

External agents can already write GDScript. They can read files, edit code, run shell commands, search the repo, and use git. If Summer MCP only wraps those same capabilities, it is noise.

The actual pain is that game projects are not just code:

- `.tscn` scene files are fragile to write by hand.
- Node paths, resources, UIDs, imports, signals, sub-resources, and inspector properties are easy for agents to get wrong.
- Agents are blind without runtime diagnostics and visual feedback.
- Godot asset import is not "download a file"; it is an engine pipeline.
- Agents need a small amount of canonical Summer knowledge at the exact moment they are building.
- Setup must be boringly easy, otherwise users will stay in plain Godot.

The product should not ask "how do we expose our whole tool?" It should ask "what makes an agent choose Summer over Godot every day?"

## Definitions

### CLI

The CLI is the human and distribution layer.

It is used for:

- installing Summer Engine
- logging into a Summer account
- creating/opening/running projects
- checking local engine status
- installing agent skills/docs
- starting the MCP server
- future direct human commands like importing templates or assets

The CLI should feel like `git`, `vercel`, or `supabase`: a reliable command-line front door. It is not where the agent should do most game-building operations.

### MCP

MCP is the agent workbench.

It is used by Codex, Claude Code, Cursor, Windsurf, and other clients to call `summer_*` tools during a build. MCP should expose only the capabilities where Summer is clearly better than direct file editing:

- live scene graph operations
- inspector/resource operations
- project/input settings
- import pipeline
- play/stop/runtime state
- diagnostics and script errors
- screenshots or visual previews when client support is good enough
- asset search/import/generation as a workflow surface
- checkpoint and review primitives when implemented cleanly

MCP should not be a duplicate shell, git, grep, or generic file API.

### Local Engine API

The local API on `localhost:6550` is plumbing, not the product. It should remain private, stable, authenticated, and boring. MCP and internal tools use it, but users should think in terms of CLI commands and MCP tools.

### Skills And Docs

Skills are agent-facing knowledge modules. They should teach the agent how to build well in Summer: scene patterns, import flows, asset placement, GDScript conventions, troubleshooting, and genre-specific workflows.

Skills are not the same as MCP tools. Tools perform actions. Skills teach when and how to use them.

### Native Summer Agent

Native Summer Agent is the paid cockpit. It can use the same engine primitives as MCP, but it also has onboarding, GameSoul, managed memory, UI diff/review, checkpoints, visual QA, asset workflows, billing, and future publishing.

## Product Thesis

The free product should make external agents excellent at operating Summer locally.

The paid product should make humans confident that the agent's output is coherent, reviewable, recoverable, asset-rich, and shippable.

That means:

- Code generation from Codex/Claude/Cursor is free to Summer users because Summer is not paying for it.
- Local engine control is free because it creates Summer projects.
- Public asset search/import should be free or extremely generous because it makes games look better immediately.
- AI-generated assets, rigging, animation, audio, video, and hosted compute are metered because they cost money.
- Native Summer Pro is paid because it removes workflow pain: memory, onboarding, review, verification, checkpoints, orchestration, and production guidance.

## Core User Stories

### External Agent User

As a user who pays for Codex, Claude Code, Cursor, or another agent, I want to connect that agent to Summer in under two minutes so it can build a playable game inside a real engine without me hand-editing scenes.

Success looks like:

1. Run `npx summer-engine install`.
2. Run `npx summer-engine login`.
3. Run `npx summer-engine create platformer my-game`.
4. Run `npx summer-engine run my-game`.
5. Add MCP config with one copy-paste or `summer mcp setup <client>`.
6. Ask the agent: "Make a small platformer."
7. The agent creates scenes through MCP, writes GDScript directly, imports assets, plays the game, reads diagnostics, fixes errors, and gives the user a working result.

### Native Summer User

As a creator who does not want to manage a separate AI tool, I want Summer itself to guide the build from idea to playable game, remember my intent, show me what changed, let me revert safely, and help me polish.

Success looks like:

1. Open Summer.
2. Onboard into a GameSoul/project brief.
3. Ask Summer Agent to build or modify the game.
4. Review scene/file/asset changes visually.
5. Accept, reject, checkpoint, rollback.
6. Generate custom assets or use free library assets.
7. Continue from memory tomorrow.

### Agent Maintainer / Power User

As an advanced developer, I want clear tool contracts and high-quality public skills so I can trust agents to use Summer correctly without stuffing my prompts with fragile instructions.

Success looks like:

- Tool descriptions are short, concrete, and accurate.
- `summer_get_agent_playbook` returns the daily operating contract.
- Skills install into Claude/Cursor/Summer easily.
- Public docs include exact examples that agents can copy.
- The tools avoid duplicating capabilities the host agent already has.

## MCP Versus Direct File Editing

The agent should use direct file editing for:

- `.gd`
- `.cs`
- `.json`
- `.md`
- most `.tres` files when the structure is simple and known
- config files when text editing is safer than engine mutation

The agent should use MCP for:

- creating or changing `.tscn` scenes
- adding/removing/replacing nodes
- setting typed inspector properties
- editing nested resources like shapes/materials on nodes
- connecting signals
- instantiating scenes or `.glb` files
- saving/opening scenes
- project settings and InputMap changes
- importing files through Godot's import pipeline
- play/stop/run-state checks
- diagnostics, console, debugger, script errors
- screenshots/previews once supported

The agent should not use MCP for:

- generic file reads/writes
- shell commands
- git operations
- grep/search
- arbitrary text replacement
- recursive project inspection that the host agent can do faster

Rule of thumb: if the operation needs the live editor or Godot's importer, it belongs in MCP. If it is normal repo work, let the host agent do it.

## Desired Tool Surface

### Keep And Polish For Free

These are the daily engine hands:

- `summer_get_agent_playbook`
- `summer_get_project_context`
- `summer_open_main_scene`
- `summer_get_scene_tree`
- `summer_inspect_node`
- `summer_inspect_resource`
- `summer_create_scene`
- `summer_open_scene`
- `summer_add_node`
- `summer_remove_node`
- `summer_replace_node`
- `summer_select_node`
- `summer_set_prop`
- `summer_set_resource_property`
- `summer_connect_signal`
- `summer_instantiate_scene`
- `summer_batch`
- `summer_save_scene`
- `summer_project_setting`
- `summer_input_map_bind`
- `summer_import_from_url`
- `summer_import_from_url_batch`
- `summer_play`
- `summer_stop`
- `summer_is_running`
- `summer_get_diagnostics`
- `summer_get_console`
- `summer_get_debugger_errors`
- `summer_get_script_errors`
- `summer_clear_console`

### Add Or Re-enable When Solid

These are high-leverage and should become part of the daily loop:

- `summer_viewport_snapshot`
- `summer_game_snapshot`
- `summer_scene_preview`
- `summer_list_checkpoints`
- `summer_restore_checkpoint`
- `summer_diff_checkpoint`
- `summer_capture_review_state`

Screenshots only matter if the MCP client can actually pass them to the model or display them usefully. If the client cannot consume images, return a local file path plus structured scene metadata and keep the tool description honest.

### Asset Tools

Asset tools should be first-class because they make Summer output visibly better than a blank Godot project.

Free or very generous:

- `summer_search_assets`
- `summer_import_asset`
- `summer_list_my_assets`
- `summer_import_my_asset`

Metered:

- `summer_generate_image`
- `summer_generate_3d`
- `summer_generate_audio`
- `summer_generate_video`
- `summer_rig_model`
- `summer_retarget_animation`
- `summer_remove_background`
- `summer_retexture_asset`

Public/library asset search should not be Pro-gated. It should require login, rate limits, attribution metadata, and abuse protection, but it should be part of the free adoption wedge.

### Remove From MCP Or Keep Internal Only

These can remain in the engine local API for native Summer, but should not be exposed as MCP tools unless a specific agent workflow proves they are better than host-native tools:

- file write/delete/rename/move/mkdir
- grep/search
- shell run/kill
- git status/diff/stage/commit/push/pull
- raw text replace
- accept/reject AI diff UI internals

## CLI Product Requirements

The CLI should optimize for setup, distribution, and human control.

### Current Commands To Keep

- `summer install`
- `summer login`
- `summer logout`
- `summer status`
- `summer run [path]`
- `summer open <path>`
- `summer create <template> [name]`
- `summer list templates`
- `summer list projects`
- `summer skills list`
- `summer skills install <name>`
- `summer mcp`

### Commands To Add

#### `summer mcp setup <client>`

Automatically configures MCP for supported clients.

Supported clients:

- `claude-code`
- `cursor`
- `windsurf`
- `codex` when local MCP config is standardized

Behavior:

- detects installed clients when possible
- writes or prints exact config
- validates `npx summer-engine mcp` works
- runs `summer status`
- explains next step in one sentence

#### `summer doctor`

One command that diagnoses the whole stack.

Checks:

- Node version
- CLI version
- login state
- engine installed
- engine running
- local API port/token
- gateway reachability
- MCP server boot
- current project path
- project.godot presence
- main scene configured

Output should be machine-readable with `--json`.

#### `summer skills install --agent <client>`

Installs public skills into the right place for each agent.

Examples:

- `summer skills install --all --agent claude-code`
- `summer skills install fps-controller --agent cursor`
- `summer skills install make-game --agent summer`

#### `summer assets search`

Human CLI wrapper around asset search.

Example:

```bash
summer assets search "low poly tree" --type 3d_model
```

This is not the main agent path, but it helps users see that the library exists.

#### `summer docs agents`

Prints links and copy-paste setup snippets for each agent.

### CLI Non-Goals

The CLI should not become a full game-building interface. Once the project is open and the agent is connected, MCP is the daily work surface.

## Skills Product Requirements

Skills are a core part of making agents prefer Summer.

### Skill Split

Public skills should be narrow but excellent, not weak versions of private skills.

Public:

- GDScript patterns
- scene composition
- 3D lighting
- UI basics
- FPS controller
- asset strategy
- import pipeline
- debugging loop
- tiny polished reference workflows

Private or native Pro:

- full arbitrary "make game" orchestration
- broad genre builders
- adaptive planning
- GameSoul interpretation
- visual QA heuristics
- project memory strategy
- multi-agent orchestration
- premium templates and production packs

### Public Skill Quality Bar

A public skill must:

- include exact MCP tool names
- include valid Godot 4/Summer examples
- explain when to use direct file edits instead of MCP
- include known failure modes
- be tested against a real project
- be short enough that an agent will actually use it

### The Agent Playbook

`summer_get_agent_playbook` should become the runtime version of the docs. It should answer:

- What should I do first?
- When do I use MCP?
- When do I write files directly?
- What are the common scene mistakes?
- How do I recover from no scene open, wrong path, import failure, script error?

This tool should be free, stable, and called at the start of every fresh chat.

## Documentation Requirements

The docs page should be optimized for agents and humans, not marketing.

Required pages:

- "Use Summer with Claude Code"
- "Use Summer with Codex"
- "Use Summer with Cursor"
- "MCP Tool Reference"
- "Agent Playbook"
- "Scene Ops vs File Edits"
- "Asset Library and Import"
- "AI Asset Generation and Credits"
- "Troubleshooting MCP"
- "Skill Packs"

Each agent setup page must include:

- install command
- login command
- engine run command
- MCP config
- verification prompt
- common failure fixes

Example verification prompt:

```text
Use Summer Engine MCP. First call summer_get_project_context and summer_get_agent_playbook, then add a DirectionalLight3D and Camera3D to the main scene, save it, and check diagnostics.
```

## Free Versus Paid Boundary

### Free

- Engine
- CLI
- MCP local engine tools
- public skills
- public docs
- project creation
- local scene manipulation
- direct external-agent code generation
- play/stop/diagnostics
- public asset search/import with attribution and rate limits
- user's own generated/uploaded asset library

### Metered Credits

- image generation
- 3D generation
- audio/music generation
- video generation
- rigging
- animation retargeting
- background removal
- retexturing
- other hosted provider calls

### Pro Subscription

Pro should not mean "pay to call MCP." Pro should mean "Summer manages the production workflow."

Pro includes:

- native Summer Agent
- onboarding and GameSoul flow
- persistent project memory
- managed build plans
- review/apply/reject UI
- checkpoint timeline and rollback
- richer visual QA
- premium skills/templates where they are delivered inside native Summer
- monthly included usage wallet
- priority queues or higher limits for hosted generation

### Team/Ultra Later

- shared projects
- team memory
- private asset libraries
- shared billing
- review roles
- higher usage allocation
- support

## Asset Library Policy

The 25k public/community/free assets should be exposed through MCP.

Rules:

- Require login.
- Rate limit search and import.
- Return license, author, source, pack, and attribution metadata.
- Prefer import-ready URLs and exact `res://` output paths.
- For assets requiring textures, import texture dependencies first.
- Write or update a project attribution file when needed.
- Do not let MCP bulk-download the whole library.
- Do not Pro-gate basic library search.

This is not "giving away leverage." It is making Summer games stop looking empty.

## Agent Daily Workflow

The ideal external-agent loop:

1. Call `summer_get_project_context`.
2. Call `summer_get_agent_playbook`.
3. Open the main scene if needed.
4. Inspect the scene tree.
5. Edit `.gd` files directly.
6. Use MCP for scene graph changes.
7. Search/import assets when the scene needs content.
8. Save scenes.
9. Run script error checks.
10. Play the game.
11. Read diagnostics/debugger output.
12. Take visual snapshot/preview when available.
13. Fix issues.
14. Create or restore checkpoint when needed.
15. Summarize what changed.

The agent should feel that Summer removes the annoying parts of Godot scene work.

## MVP Scope

### MVP 1: Agent Setup That Actually Works

Ship:

- `summer mcp setup claude-code`
- `summer mcp setup cursor`
- `summer doctor`
- refreshed README quickstart
- docs pages for Claude Code, Cursor, Codex
- verification prompt
- fix asset search Pro gating
- remove visible local MCP quota paywall

Success:

- fresh machine to working MCP in under 2 minutes
- first successful tool call is obvious
- failure messages say exactly what to do

### MVP 2: Better Agent Tool Loop

Ship:

- tighten tool descriptions
- `summer_get_agent_playbook` v2
- expose `summer_scene_preview` or screenshot path workflow if reliable
- expose checkpoint list/restore/diff if stable
- add `summer_list_my_assets`
- add `summer_import_my_asset`
- make asset import return exact paths and dependency metadata

Success:

- agents stop guessing scene paths
- agents stop editing `.tscn` directly
- agents can verify after changes
- asset placement works in real projects

### MVP 3: Public Skills That Are Actually Good

Ship:

- installable `make-small-3d-game` reference cartridge
- installable `debug-fix-loop`
- installable `asset-import-pipeline`
- installable `platformer-2d`
- installable `fps-controller`
- docs page explaining skills by agent

Success:

- external agents build a better first game with skills than without
- skills are narrow, complete, and tested

### MVP 4: Native Pro Differentiation

Ship inside Summer:

- GameSoul onboarding
- project memory visible to user
- checkpoint timeline
- review/apply/reject flow
- visual QA panel
- asset generation wallet

Success:

- external MCP is good
- native Summer is calmer and safer
- Pro is not "more MCP"; Pro is the managed production cockpit

## Metrics

Activation:

- CLI installs
- `summer login` completion
- `summer mcp setup` completion
- first successful MCP tool call
- first project created
- first scene saved through MCP

Agent quality:

- tool-call success rate
- scene op failure rate
- percentage of sessions calling play/diagnostics
- percentage of sessions importing assets
- script-error fix loop completion
- time from install to playable scene

Retention:

- projects reopened
- weekly MCP active users
- weekly native Summer active users
- games with at least one imported asset
- games with at least one successful play run

Monetization:

- generated asset usage
- credit top-ups
- Pro conversion after external MCP usage
- Pro retention
- native agent sessions per Pro user

## Open Product Decisions

### Should screenshot tools be free?

Default answer: yes, if they are local and cheap. They are core to making agents build better games. Meter only if the workflow calls hosted vision or expensive analysis.

### Should public asset search be free?

Default answer: yes. Rate-limit it and require attribution. Empty games do not convert.

### Should skills be open?

Default answer: open narrow, excellent reference workflows. Keep broad adaptive orchestration and production intelligence inside native Summer.

### Should local MCP require login?

Default answer: yes for cloud-connected features, maybe no for purely local engine tools. Best UX may be:

- local engine ops work without web login using local API token
- cloud asset/library/generation tools require `summer login`
- analytics asks for opt-in or runs only when logged in

Do not block local scene editing because the user forgot web auth.

### Should local MCP calls be quota-limited?

Default answer: no visible quota. Keep silent abuse protection if needed. A visible "100 calls/week" limit makes the bridge feel fake and harms adoption.

## Implementation Notes From Current Code

Current useful foundations:

- Engine local API: `modules/1summer_engine/api/local_api_server.cpp`
- Ops dispatcher: `modules/1summer_engine/editor/ops_executor.cpp`
- State provider: `modules/1summer_engine/editor/state/state_provider.cpp`
- MCP server: `tools/summer-cli/src/mcp/server.ts`
- MCP tools: `tools/summer-cli/src/mcp/tools/`
- Cloud MCP routes: `publicsummerengine/app/api/mcp/`
- Skills: `tools/summer-cli/skills/`

Current implementation issues to revisit:

- Local MCP quota is visibly monetized. It should become silent abuse protection or be removed from local tools.
- Public asset library search is Pro-gated. It should be free/generous with rate limits.
- Some docs say snapshots are disabled. Revisit once client image support is understood.
- The "make-game" skill is likely too broad for public quality unless it is tested as a narrow reference cartridge.
- The tool docs still encode old assumptions like "normal code/content edits (.gd/.tscn/.tres/.ts) use host file-edit tools"; this should explicitly exclude `.tscn` and recommend MCP for scenes.

## Non-Goals

- Build a generic AI coding product.
- Charge users for external agent code generation.
- Duplicate shell/git/file tools that host agents already have.
- Expose every internal engine op through MCP.
- Make MCP the premium product.
- Let agents bulk-scrape the public asset library.

## Final Product Shape

CLI:

The easiest way to install, run, diagnose, configure, and feed Summer to agents.

MCP:

The agent's live engine workbench: scenes, imports, play, diagnostics, assets, visual feedback.

Skills/docs:

The agent's Summer-specific memory: how to build correctly without bloated prompts.

Native Summer Pro:

The managed production cockpit: GameSoul, memory, checkpoints, review, visual QA, assets, orchestration, and eventually publishing.

The goal is simple: when an agent is asked to build a game, it should prefer Summer because the engine gives it the missing hands and eyes.
