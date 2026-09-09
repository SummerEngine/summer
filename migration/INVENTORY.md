# Summer v3 Foundation — Migration Inventory (human summary)

Generated 2026-09-01 by the inventory extractor.

**Baseline: commit `e49189b93fcfee88b57e22ba8467cc782b292ac0` (origin/main at inventory time).**
Important: this worktree (`v3-foundation`) was already being refactored by other agents while the inventory ran (src/lib was reorganized into src/core/, src/project-memory/, src/lib/registry/ in commits after e49189b). To keep the inventory internally consistent, every file in `migration/` was extracted from a `git archive e49189b` snapshot, NOT from the live working tree. All paths below are as they exist at e49189b.

## Counts

| Thing | Count | Verified against |
|---|---|---|
| Skills on disk (`skills/**/SKILL.md`) | **79** | `find skills -name SKILL.md \| wc -l` = 79 |
| Skills in `.claude-plugin/plugin.json` | 79 | all 79 present |
| Skills in `.codex-plugin/plugin.json` | 75 | 4 missing (below) |
| Skills in `.cursor-plugin/plugin.json` | 75 | same 4 missing |
| Skills in `src/lib/skills-registry.ts` SKILL_REGISTRY | 69 | 10 missing (below) |
| MCP tools (`server.tool(` in `src/mcp/tools/*.ts`) | **62** | grep total = 62; AST extraction = 62 |
| CLI commands (`src/commands/*.ts`, all registered in `src/bin/summer.ts`) | **21** | registration order captured |
| CLI↔MCP shared lib functions (`sharedCapabilities`) | 20 | cloud sync ×7, creator ×3, config ×6, auth, memory, debug report, game-task plan |
| Reference/docs files (`references/` + `docs/`) | 24 | 21 markdown + 3 brand PNGs |
| Manifest/integration files inventoried | 20 | incl. hooks, commands, _persona, AGENTS/GEMINI/CLAUDE.md |
| Live GitHub `template-*` repos (SummerEngine org) | **17** | `gh api orgs/SummerEngine/repos`, SHAs fetched per default branch |
| Built-in templates (`src/commands/create.ts`) | 2 | `empty`, `3d-basic` |

## Skill drift table

69 of 79 skills are present in **all four** places (claude plugin, codex plugin, cursor plugin, SKILL_REGISTRY). The 10 exceptions:

| Skill | claude | codex | cursor | registry |
|---|---|---|---|---|
| 2d-assets/instantiate-asset-pack | yes | NO | NO | NO |
| 2d-assets/use-widget-asset | yes | NO | NO | NO |
| gameplay-mechanics/auto-fire-targeting | yes | NO | NO | NO |
| level-design/scene-to-level | yes | NO | NO | NO |
| workflow/gameskill | yes | yes | yes | NO |
| workflow/mcpupdate | yes | yes | yes | NO |
| workflow/skill-create | yes | yes | yes | NO |
| workflow/skill-improve | yes | yes | yes | NO |
| workflow/skill-test | yes | yes | yes | NO |
| workflow/using-summer | yes | yes | yes | NO |

No registry entry or manifest path points at a skill missing on disk (zero dangling references).

## Proposed stable IDs (kebab-case = folder name; zero collisions)

All 79 folder names are globally unique, and every SKILL.md frontmatter `name` equals its folder name, so **proposed ID = folder name** everywhere.

- **workflow (16)**: brainstorming, debugging-game-feel, diagnosing-perf-regressions, dispatching-parallel-agents, gameskill, headless-scripting, investigating-bugs, mcpupdate, playtesting-a-feature, skill-create, skill-improve, skill-test, using-summer, verification-before-completion, writing-plans, writing-skills
- **2d-assets (10)**: character-portrait, concept-art, create-asset-sheet, instantiate-asset-pack, pixel-art, skybox-panorama, sprite-sheet, tileable-texture, ui-graphics, use-widget-asset
- **visual-effects (9)**: game-feel + recipes/: dissolve, fire, hit-spark, lightning, magic-glow, muzzle-flash, smoke, water-ripple
- **scene-and-project (7)**: brainstorm-game, browse-templates, make-game, new-project, play, scene-composition, summer-cloud
- **audio (6)**: adaptive-music, ambient-bed, audio-direction, music-track, sound-effect, voice-line
- **3d-assets (5)**: character-model, environment-kit, organic-model, prop-model, vehicle-model
- **animation (5)**: animation-tree, facial-and-lipsync, generate-motion, procedural-animation, retarget
- **multiplayer-and-networking (3)**: host-authoritative-state, peer-to-peer-multiplayer, setup-multiplayer
- **video (3)**: animated-loop, cinematic-cutscene, trailer-shot
- **deployment (2)**: export-and-ship, remote-deploy · **gameplay-mechanics (2)**: auto-fire-targeting, design-mechanic · **level-design (2)**: design-level, scene-to-level · **rendering-and-lighting (2)**: 3d-lighting, art-direction
- **singletons (7)**: design-npc (ai-and-npcs), asset-strategy (asset-pipeline), fps-controller (character-controllers), debug (debugging), tune-performance (performance), gdscript-patterns (scripting-patterns), ui-basics (ui-and-ux)

Watch-out: the 8 VFX recipe IDs (fire, smoke, dissolve, ...) sit one directory deeper (`skills/visual-effects/recipes/<id>/`) and are generic words. They are collision-free today; if the v3 registry wants self-describing IDs, `vfx-fire` etc. is the obvious prefix — decision left to the registry compiler owner.

## Manifest tool-count claims vs reality (actual: 62)

| File | Claim |
|---|---|
| .claude-plugin/plugin.json | "58-tool MCP bridge" |
| .claude-plugin/marketplace.json | "50+ tool MCP bridge" |
| .codex-plugin/plugin.json | "62-tool MCP bridge" (correct) |
| .cursor-plugin/plugin.json | "58-tool MCP bridge" |
| .factory-plugin/plugin.json | "52-tool MCP bridge" |

## Templates

- Task brief said "12 rows incl. TBDs" — the actual `references/template-registry.md` at e49189b has **2 built-in + 14 community rows and no TBD rows**. Inventory records what is actually there.
- Live org has **17** `template-*` repos. **3 are missing from the registry snapshot**: `template-3d-procedural-road-world`, `template-3d-city-kit` (both with default branch `codex/importable-template` — the CLI clones the default branch, so that branch IS what users get), and `template-2d-dungeon-roguelike` (default branch `master`). All 14 snapshot rows exist live (0 stale rows).
- Non-`main` default branches worth knowing: `template-3d-fps-old-school` → `bror-templates`; `template-3d-third-person-controller`, `template-2d-dungeon-roguelike` → `master`; the two codex ones above.
- **Broken cross-link**: the only skill declaring a `template-id` is `character-controllers/fps-controller` → `template-3d-fps`, and **no such repo exists** (closest: `template-3d-fps-old-school`, `template-3d-fps-simple-animated-npc`). The skill-test linter would not catch it because it validates against the registry table, which also doesn't list `3d-fps`.

## Other ambiguities / notes

1. **Moving target**: the worktree advanced past e49189b during extraction (v3 refactor commits by other session agents, e.g. `src/lib/skills-registry.ts` no longer exists in the live tree — it moved under the src/core/ carve-up). Everything here is pinned to e49189b; downstream agents mapping "current path" → new layout must translate through the refactor commits.
2. **80th SKILL.md**: `_persona/summer/SKILL.md` (hosted-orchestrator persona) lives outside `skills/` and is deliberately not counted in the 79; it is captured in manifests-inventory.
3. **Frontmatter inconsistency**: 11 workflow skills (brainstorming, debugging-game-feel, diagnosing-perf-regressions, dispatching-parallel-agents, headless-scripting, investigating-bugs, mcpupdate, playtesting-a-feature, verification-before-completion, writing-plans, writing-skills) lack the `license`/`compatibility`/`category` frontmatter keys the other 68 carry. Per-skill keys are recorded in skills-inventory.json.
4. **hooks-cursor.json `"version": 1`** is the hooks schema version, not the plugin version.
5. `sharedLibCalls` in tools-inventory.json is static analysis (imports from `src/lib/*` referenced in each handler/command file), not a runtime trace. 38 of 62 MCP tools use `withEngine` (desktop-app bridge) rather than shared lib functions — see `usesWithEngine` per tool.
6. `docs/brand/*.png` are binary; recorded with byte size, no line count.
7. gemini-extension.json and .factory-plugin/plugin.json carry **no skill lists at all** (Gemini relies on the npm CLI for skills; Factory is metadata-only) — the registry compiler must decide whether that stays intentional.

## Files in this directory

1. `skills-inventory.json` — 79 skills: frontmatter, files, line counts, manifest presence, proposed IDs.
2. `tools-inventory.json` — 62 MCP tools (name/file/description/schema keys/lib calls) + 21 CLI commands + 20 sharedCapabilities pairs.
3. `manifests-inventory.json` — 20 manifest/integration files with full contents, versions, skill lists, tool-count claims.
4. `templates-inventory.json` — 2 built-ins, registry snapshot rows, remote-templates.ts resolution contract, 17 live GitHub repos with default branch + latest SHA.
5. `references-inventory.json` — 24 files under references/ + docs/ with title/summary/line count.
6. `INVENTORY.md` — this file.
