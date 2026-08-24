# Skills

Summer skills teach AI agents how to build Summer games in Summer Engine with
the Summer SDK, GDScript, and `.tscn` scenes. Version-sensitive guidance follows
the repository compatibility contract instead of pinning onboarding to one
upstream release. Two kinds:

## Workflow skills (slash commands)

User-invocable. The user types `/<name>` to trigger them. Each is a guided workflow that opens with a clarifying question and orchestrates specialist skills + MCP tools.

| Slash | What it does |
|---|---|
| `/summer debug` | Create a support-ready debug report, then optionally continue the debug loop |
| `/debug` | Triage and fix a bug end-to-end |
| `/play` | Run the game and report state |

More coming as the library grows. See the `skills:` array in `.claude-plugin/plugin.json` for what ships today.

## Specialist skills (auto-triggered)

Not invoked directly. Auto-load when the user's prompt matches the skill's `description:` field. The user describes intent ("make me an FPS", "add lighting", "I need a HUD") and the right specialist fires.

| Skill | Auto-trigger phrases |
|---|---|
| `fps-controller` | "FPS", "first-person", "WASD", "character controller" |
| `3d-lighting` | "lighting", "shadows", "WorldEnvironment", "sun" |
| `ui-basics` | "UI", "HUD", "menu", "health bar", "Control" |
| `gdscript-patterns` | "GDScript", "signals", "exports", "type hints" |
| `scene-composition` | "scene structure", "sub-scene", "instance", "prefab" |
| `asset-strategy` | "assets", "3D models", "textures", "art pipeline" |
| `make-game` | "make a game", "build me a game" (broad, less recommended) |

## Commands

```bash
summer skills list                                     # List all
summer skills info <name>                              # Detail on one
summer skills install <name>                           # Install one
summer skills install --recommended --agent codex      # Install recommended set
summer skills install --all --agent claude-code        # All public skills
summer skills install --recommended --agent cursor --scope project   # Per-project
```

Supported agents: `summer`, `codex`, `claude-code`, `cursor`, `windsurf`, `cline`, `roo-code`, `kilo-code`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`, `bionic`. Supported scopes: `user`, `project`.

## Recommended set

`--recommended` includes both workflow and specialist skills, excludes the broad `make-game`:

- `debug`, `play` (workflows)
- `fps-controller`, `3d-lighting`, `gdscript-patterns`, `scene-composition`, `ui-basics`, `asset-strategy` (specialists)

## Registry

Two source-of-truth files:

- `.claude-plugin/plugin.json` `skills:`: what Claude Code auto-discovers when the plugin is installed. Sibling manifests such as `.codex-plugin/plugin.json` can differ when a host supports a smaller surface.
- `src/lib/skills-registry.ts` `SKILL_REGISTRY`: what `summer skills install` writes to non-plugin agents (Devin Desktop (formerly Windsurf), Cline, Roo, Gemini, Copilot, OpenCode).

These surfaces must stay intentionally synced, but they are not always the same raw count. Do not publish a single skill total unless the sentence says whether it means disk files, plugin paths, registry entries, or recommended installs. `plugin-manifests.test.ts` catches accidental manifest drift.

Per-skill metadata:

- `name`
- `category` (one of 20)
- `public`
- `recommended`
- `user-invocable` (true = slash command, false = auto-trigger only)
- `requiresMcpTools`
- `testScenario`

## Authoring rules

1. **Specialist skills:** narrow technical knowledge, auto-trigger via rich `description:`. Set `user-invocable: false`.
2. **Workflow skills:** action-verb names (`/debug`, `/play`), open with one clarifying question, orchestrate specialists. Set `user-invocable: true`.
3. SKILL.md <= 500 lines. Push detail into `references/`.
4. Show Summer MCP-preferred + explicit offline/manual fallback in every code-touching skill.
5. Teach identity-bound file mutation for `.tscn`/`.tres`: use `summer_read_file` plus guarded `summer_replace_text`/`summer_write_file`, and use scene tools for live hierarchy/inspector work.
6. "May I write this change?" before any user-visible mutation. See `references/collaborative-protocol.md`.
7. Every skill ships `tests/spec.md` with at least one Test Case. See `workflow/skill-test/SKILL.md`.

## Standard

Adopts the **Anthropic Agent Skills open standard** (`agentskills.io`). SKILL.md portable across Cursor / Codex / Claude Code / Devin Desktop. Summer-specific extensions: `compatibility`, `category`, `template-id`. Anthropic spec ignores unknown frontmatter fields, so portability holds.
