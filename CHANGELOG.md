# Changelog

All notable changes to summer-engine will be documented here. Following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [2.0.0] — 2026-05-09 — "Superpowers"

The plugin rebrand. Summer is now positioned as superpowers for AI game dev — installable in Claude Code, Codex (CLI + App), Cursor, Factory Droid, Gemini CLI, OpenCode, GitHub Copilot CLI, and Windsurf with one canonical command per harness.

### Added
- **`summer:using-summer`** meta-skill — establishes workflow priority, red-flag list, and skill-invocation discipline. Auto-loads on session start. Modeled on `superpowers:using-superpowers`.
- **`summer:debug`** skill — the missing flagship skill. Disciplined script-errors → console → debugger → hypothesize → propose → fix → verify loop. Honors all 4 cases in `_tests/specs/debug.md`.
- **Manifest validator** (`src/lib/plugin-manifests.test.ts`) — vitest test that walks every plugin manifest and verifies each referenced skill resolves to a real `SKILL.md` on disk. Also enforces the "Use when…" auto-trigger pattern in every skill's description.
- **`AGENTS.md`** + **`GEMINI.md`** at repo root — context primer for harnesses that read AGENTS-style files (Codex, Factory) and the Gemini extension.
- **`.opencode/INSTALL.md`** — explicit OpenCode setup guide.
- **`docs/marketplace-repo/`** — drop-in contents for the separate `SummerEngine/summer-marketplace` repo (Claude marketplace listing).
- Multiplayer skills (`host-authoritative-state`, `peer-to-peer-multiplayer`) added to all plugin manifests.

### Changed
- **Brand:** "Summer" replaces "Summer Engine CLI" across all plugin descriptions, READMEs, and orientation banners. The npm package stays `summer-engine` (continuity).
- **README** rewritten in superpowers-homepage style — install matrix per harness, philosophy section, basic workflow walkthrough.
- **MCP_STRATEGY.md** updated: documents the deliberate decision to NOT ship file/git/shell/grep tools (host agents have those natively). 37 tools shipped.
- All 22 user-facing skill descriptions audited and rewritten to lead with "Use when X" for tighter auto-trigger.
- `.codex-plugin/plugin.json` `longDescription` rewritten — accurate skill count, mentions the host-native tool exclusion.
- `.opencode/plugins/summer.js` orientation banner updated to 22 skills with explicit process / discipline / build priority.

### Fixed
- **Critical:** 4 broken skill paths in `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json`. Plugin install would silently fail for `gdscript-patterns`, `ui-basics`, `asset-strategy`, and `debug` (the latter didn't exist at all). All paths now resolve.
- 2 missing HAVE-status multiplayer skills now listed in all manifests.
- TypeScript build excludes `*.test.ts` so `npx tsc` produces clean dist without vitest type leakage.

### Notes for plugin install
- After v2, `claude /plugin install summer@summer-marketplace` resolves cleanly. The `SummerEngine/summer-marketplace` repo (one-file marketplace) needs to be created and pushed; contents are in `docs/marketplace-repo/`.
- Existing `1.x` users updating: `npm update -g summer-engine` then `summer setup <agent> --yes` to refresh skill installs.

## [1.3.2] — 2026-05-05

### Fixed
- `summer_input_map_bind` syntax aligned across `fps-controller` SKILL.md and its behavioral test spec.
- `_meta/skill-test` static linter relaxed to allow forward-reference `See also` links to other SKILL.md files (warn instead of fail).

### Added
- `_shared/summer-folder.md` — canonical `.summer/` folder convention (documents files written by `/summer:brainstorm-game`, `/summer:art-direction`, etc.).
- `CHANGELOG.md` — retroactive v1.0.0 → v1.3.1 history.

## [1.3.1] — 2026-05-05

### Added
- ASCII banner displays on bare `summer` command (`npx summer-engine`).
- ANSI colors throughout: green ✓ for OK, yellow ⚠ for warnings, red ✗ for failures.
- Brand line + colored slash command list in setup output.
- `/debug` workflow skill — triage and fix a bug end-to-end via Summer MCP diagnostics.
- `/play` workflow skill — run the game and report state.
- 7 specialist skills marked `user-invocable: false` (auto-trigger only).

### Fixed
- `summer doctor` defaults to human-readable output instead of JSON.
- Engine path display shortened (`/Applications/Summer.app/Contents/MacOS/Summer` → `/Applications/Summer.app`).
- Home-relative paths now display tildeified.
- MCP server status no longer leaks "stdio" implementation detail (now reads "ready").
- `tools/summer-cli/src/bin/` finally tracked in git (root `.gitignore`'s `[Bb]in/` was silently excluding the npm entrypoint).
- `LICENSE` now bundled in the npm tarball.

## [1.3.0] — 2026-05-05

### Added
- 20-category skill library scaffold with descriptive folder names (`character-controllers`, `gameplay-mechanics`, `scripting-patterns`, etc.).
- `_shared/` directory with 5 canonical references (godot-version, mcp-tools-reference, collaborative-protocol, template-registry, gd-style).
- `_meta/` directory with 3 meta-skills (skill-test linter, skill-create bootstrap, skill-improve eval harness).
- `_tests/specs/` directory with per-skill behavioral test specs (fps-controller as canonical format).
- `catalog.yaml` — 85-skill roadmap with HAVE / NEXT / LATER status.

### Changed
- 7 existing skills migrated into category folders with Anthropic-spec frontmatter (`category`, `template-id`, `allowed-tools`, `paths`).
- CLI `skills install` walks `<skillsDir>/<category>/<name>/` paths.

## [1.2.1] — 2026-05-05

### Added
- `summer setup <agent>` — one-shot MCP config + recommended skills install + doctor.
- `summer doctor` — node, login, engine, local API, MCP boot diagnostics.
- `summer mcp setup <agent>` — idempotent JSON/TOML config writer.
- Multi-agent skills install (codex, claude-code, cursor, windsurf with user/project scopes; Cursor `.mdc` rule generation; Windsurf rule blocks).
- Skill registry (`src/lib/skills-registry.ts`) with category metadata.
- Per-agent docs (OVERVIEW, CLAUDE_CODE, CODEX, CURSOR, SKILLS, TEMPLATES).

### Changed
- `/api/mcp/assets`: removed Pro gate; public/community asset search now free for all signed-in users (deployed on summerengine.com).
- `/api/mcp/log-local-call`: removed visible 100/week quota; auth-gated telemetry only.

## [1.2.0] — 2026-04-23

### Added
- Initial public release on npm.
- MCP server with 36 `summer_*` tools.
- 7 specialist skills (`fps-controller`, `gdscript-patterns`, `scene-composition`, `3d-lighting`, `ui-basics`, `asset-strategy`, `make-game`).
- CLI commands (`install`, `login`, `logout`, `status`, `run`, `open`, `create`, `list`, `skills`, `mcp`).
- MIT license.
