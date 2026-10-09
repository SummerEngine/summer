# Naming conventions

What is called what. **Do not deviate without updating this file first.**

## The five names

| Thing | Name | Use it for |
|---|---|---|
| **The product** | **Summer** | The open-source system in this repo: the library, the live tools (MCP + CLI), project memory, evals. "Install Summer", "build it with Summer", "Summer's library". |
| **The editor** | **Summer Engine** | The proprietary desktop app — editor + runtime — that `summer install` downloads. Always two words. Never shorten it to "Summer" when you mean the app; never call the system "Summer Engine". |
| **GitHub repo** | `summerengine/summer` | GitHub URLs are case-insensitive; write it lowercase. |
| **npm package** | `summer-engine` | What users install: `npx -y summer-engine@latest …`. Stays as-is forever — thousands of MCP configs run it. Never recommend `summer-cli` (an unrelated, inactive package we do not own). |
| **Binary** | `summer` | The CLI entry point (`package.json` `bin.summer`), also the MCP server (`summer mcp`). |

## Skill and command names (what agents type)

| Surface | Form | Notes |
|---|---|---|
| A skill, in prose or in another skill | bare slug: `` `design-mechanic` ``, "use the `fps-controller` skill" | The slug is the `library/skills/<slug>/` directory name and the `name:` in its SKILL.md. Rules: `DEVELOPMENT.md`, "How skills reference each other". |
| A skill installed by `summer setup` | `/<slug>` in Claude Code; the host's equivalent elsewhere | Installed skills are plain user skills; there is **no `summer:` prefix**. |
| A skill loaded through the plugin marketplace | `/summer:<slug>` | Only under the `.claude-plugin` install; do not write this form in skills or docs — the bare slug resolves under both installs. |
| Shipped slash commands | `/summer <request>`, `/gameskill` | `commands/summer.md` (the game-dev router persona) and `commands/gameskill.md`. |
| Retired v2 forms | `summer:<category>/<name>`, `<category>/<name>`, `skills/<category>/<name>` | Categories are gone (`library/skills/` is flat). Recorded as aliases; nothing resolves them at runtime. Do not write them. |
| MCP tools | `summer_<verb>_<noun>` | e.g. `summer_get_scene_tree`. The `surfaces.mcp.tool_name` in each `library/tools/<slug>/resource.yaml`. |
| The same tool from the shell | `summer tool <slug> --args '<json>'` | Slug = the `library/tools/<slug>` directory name (`get-scene-tree`). |
| Library ids | `<kind>/<slug>` | `skill/fps-controller`, `template/3d-basic`, `tool/get-scene-tree`. Permanent. |

## Manifest identifiers (generated — edit `integrations/`, not the files)

| File | `name` |
|---|---|
| `.claude-plugin/plugin.json` | `summer` |
| `.claude-plugin/marketplace.json` | `summer-engine`, with one plugin entry `summer` — the marketplace install reads "install the `summer` plugin from the `summer-engine` marketplace": `claude /plugin install summer@summer-engine` |
| `.codex-plugin/plugin.json` | `summer` |
| `.cursor-plugin/plugin.json` | `summer` (display name `Summer`) |
| `.factory-plugin/plugin.json` | `summer` |
| `gemini-extension.json` | `summer` in the repo; the installer writes it into `~/.gemini/extensions/summer-engine/` renamed to `summer-engine` to match the directory |
| `package.json` | `name: summer-engine`, `bin.summer`, `main: .opencode/plugins/summer.js` |
| MCP server name in host configs | `summer-engine` (what `summer setup` writes; `SUMMER_MCP_SERVER_NAME` overrides) |
| Setup targets | `claude-code`, `claude-desktop`, `codex`, `cursor`, `windsurf`, `antigravity`, `cline`, `cline-cli`, `kilo-code`, `github-copilot`, `vscode-copilot`, `visual-studio`, `copilot-jetbrains`, `opencode`, `zed`, `kiro`, `goose`, `hermes`, `trae`, `qwen-code`, `kimi-code`, `crush`, `amp`, `factory`, `junie`, `warp`, `rovo-dev`, `qoder`, `grok-build`, `mistral-vibe`, `lm-studio`; legacy `gemini`, `roo-code`. One row per agent in `src/installer/agent-table.ts` |

Filesystem names shared with the desktop engine — do not rename: `~/.summer/` (`api-token`, `auth-token`, `creator-token`, `user.json`, `config.json`, `credential-metadata.json`, `creator-audit.jsonl`, `instances/`), and `.summer/` in every project (`GameSoul.md`, `project.json`, `memory/`).

## Copy rules

| Situation | Write |
|---|---|
| Headline / first mention | "Summer is the open-source game-development system for AI agents." |
| The app the user downloads | "Summer Engine" ("the Summer Engine app" when the distinction matters) |
| The package in a command | code-style `summer-engine`; the binary, code-style `summer` |
| Platform publishing | "the Summer store" (`summer_export_game`, `summer_publish_build`). `summer publish` and `summer_creator_*` are the deprecated legacy creator API. |
| The technical base | "Summer Engine's upstream technical base is Godot 4.6.1" — use the upstream name only where compatibility, migration, extension APIs, attribution, or licensing requires it (`library/references/godot-version`). |

## Changes that need an explicit "yes" in the same session before commit

Regardless of how obviously correct the change seems:

- The `name` field of any manifest above, or of `package.json`.
- The `version` field of `package.json` (npm publish trigger).
- Anything inside `.claude-plugin/` while a marketplace submission is in review.
- The CLI binary name (`package.json` `bin`).
- The shipped slash commands (`commands/*.md`) and the bare-slug skill convention.

Silence is not consent on these.

## Checklist before any release

- [ ] Every plugin manifest has `name: "summer"`; the marketplace has `name: "summer-engine"` with a plugin entry `summer` (all generated — run `npm run generate:registry`, never hand-edit).
- [ ] `package.json` has `name: "summer-engine"`, `bin.summer`, `main: ".opencode/plugins/summer.js"`.
- [ ] README and docs say "Summer" for the system and "Summer Engine" for the editor, never mixed.
- [ ] No `summer:<category>/<name>` or `summer:<slug>` form is used as an *invocation* anywhere in `library/**` or `docs/**`. `git grep -n 'summer:' library docs` should show only prose that explains the retired form (this file, `DEVELOPMENT.md`, `MIGRATION-V2-V3.md`) or a colon after the word "summer" in a sentence.
- [ ] The repo name in prose is `summerengine/summer`.
