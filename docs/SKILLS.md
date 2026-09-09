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
summer skills install --all --agent claude-code        # All skills (preview included)
summer skills install --all --stable-only --agent claude-code   # Stable skills only (skip preview)
summer skills install --recommended --agent cursor --scope project   # Per-project
```

Supported agents: `summer`, `codex`, `claude-code`, `cursor`, `windsurf`, `cline`, `roo-code`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`. Supported scopes: `user`, `project`.

## Recommended set

`--recommended` includes both workflow and specialist skills, excludes the broad `make-game`:

- `debug`, `play` (workflows)
- `fps-controller`, `3d-lighting`, `gdscript-patterns`, `scene-composition`, `ui-basics`, `asset-strategy` (specialists)

## Registry

One source of truth: `library/skills/<slug>/` (`resource.yaml` + `SKILL.md`).
Everything else is compiled from it by `npm run generate:registry`:

- `registry/generated/skills-registry.json`: what `summer skills list/install`
  and `summer setup` read (all agents, plugin and non-plugin).
- `.claude-plugin/plugin.json` `skills:` (plus the `.codex-plugin/`,
  `.cursor-plugin/`, `.factory-plugin/`, and Gemini manifests): what plugin
  hosts auto-discover. All GENERATED — never hand-edit.

`generate:registry --check` fails on drift between library/ and the generated
files; `plugin-manifests.test.ts` guards the applied root manifests directly.
Do not publish a single skill total unless the sentence says whether it means
disk files, plugin paths, registry entries, or recommended installs.

Per-skill metadata lives in `resource.yaml` (schema:
`registry/schemas/skill.schema.json`): `id`, `summary`, `use_when`, `facets`,
`recommended` (drives `summer skills install --recommended` / `summer setup`),
`aliases` (old `skills/<category>/<name>` paths keep resolving), `status`
(`stable` and `preview` both install in bulk — `preview` is a label for work
not yet exercised in-engine by the Summer team, carried in the skill's own
guidance, and `--stable-only` skips it; `deprecated` installs only by name),
`version`.

## Authoring rules

1. **Specialist skills:** narrow technical knowledge, auto-trigger via rich `description:`. Set `user-invocable: false`.
2. **Workflow skills:** action-verb names (`/debug`, `/play`), open with one clarifying question, orchestrate specialists. Set `user-invocable: true`.
3. SKILL.md <= 500 lines. Push shared detail into `library/references/`.
4. Show Summer MCP-preferred + explicit offline/manual fallback in every code-touching skill.
5. Teach identity-bound file mutation for `.tscn`/`.tres`: use `summer_read_file` plus guarded `summer_replace_text`/`summer_write_file`, and use scene tools for live hierarchy/inspector work.
6. "May I write this change?" before any user-visible mutation. See `library/references/collaborative-protocol/collaborative-protocol.md`.
7. Every skill ships `tests/spec.md` with at least one Test Case. See `library/skills/skill-test/SKILL.md`.

## Standard

Adopts the **Anthropic Agent Skills open standard** (`agentskills.io`). SKILL.md portable across Cursor / Codex / Claude Code / Devin Desktop. Summer-specific extensions: `compatibility`, `category`, `template-id`. Anthropic spec ignores unknown frontmatter fields, so portability holds.
