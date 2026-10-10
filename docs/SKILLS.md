# Skills

Summer skills teach AI agents how to build Summer games in Summer Engine with
the Summer SDK, GDScript, and `.tscn` scenes. Version-sensitive guidance follows
the repository compatibility contract instead of pinning onboarding to one
upstream release.

The browsable index, one section per domain, is the generated
[`library/skills/README.md`](../library/skills/README.md). In a terminal:
`summer skills list` (add `--by-domain` to group them).

## Two kinds

- **Workflow skills** (`user-invocable: true`): the user can call them by name, such as `/debug`, `/play` or `/brainstorm-game` in Claude Code. Each opens with a clarifying question and drives specialist skills and MCP tools.
- **Specialist skills** (`user-invocable: false`): narrow technical knowledge. The host loads one when the user's request matches its description ("make me an FPS", "add lighting", "I need a HUD").

## Commands

```bash
summer skills list                                     # List all
summer skills info <name>                              # Detail on one
summer skills install <name>                           # Install one
summer skills install --recommended --agent codex      # Install the recommended set
summer skills install --all --agent claude-code        # All skills (preview included)
summer skills install --all --stable-only --agent claude-code   # Stable skills only (skip preview)
summer skills install --recommended --agent cursor --scope project   # Per-project
```

`summer skills install --help` lists the supported `--agent` values. Scopes: `user`, `project`.

`--recommended` installs the skills marked `recommended: true` in their `resource.yaml`. Plain `summer setup <agent>` installs every skill.

## Registry

One source of truth: `library/skills/<slug>/` (`resource.yaml` + `SKILL.md`).
The folder is flat by design (categories are `facets.domains`, see
`docs/design/DECISIONS.md` D3). Everything else is compiled from it by
`npm run generate:registry`:

- `library/skills/README.md`: the browsable index (`skills-index.md`).
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
`recommended` (drives `summer skills install --recommended`),
`aliases` (old `skills/<category>/<name>` paths, recorded in
`registry/generated/aliases.json`), `status`
(`stable` and `preview` both install in bulk — `preview` marks work not yet
exercised in-engine, carried in the skill's own guidance, and `--stable-only`
skips it; `deprecated` installs only by name), `version`.

## Authoring rules

- **The SKILL.md `description` is the resource `summary`, verbatim** (≤160 chars).
  Hosts inject every installed skill's name and description into every
  session; Codex truncates past its budget and Claude Code's budget is about
  15k characters for all skills together. Ninety-plus skills only fit when
  each description is one short line. Put trigger phrases and examples in the
  skill body, not the description. `npm run validate:library` enforces the match.

1. **Specialist skills:** narrow technical knowledge. Set `user-invocable: false`.
2. **Workflow skills:** action-verb names (`/debug`, `/play`), open with one clarifying question, orchestrate specialists. Set `user-invocable: true`.
3. SKILL.md <= 500 lines. Push shared detail into `library/references/`.
4. Show the Summer MCP path plus an explicit offline/manual fallback in every code-touching skill.
5. Teach identity-bound file mutation for `.tscn`/`.tres`: use `summer_read_file` plus guarded `summer_replace_text`/`summer_write_file`, and use scene tools for live hierarchy/inspector work.
6. "May I write this change?" before any user-visible mutation. See `library/references/collaborative-protocol/collaborative-protocol.md`.
7. A skill may ship `tests/spec.md` with Test Cases; `library/skills/skill-test/SKILL.md` runs the structural checks every skill must pass (frontmatter, `resource.yaml` schema, routing metadata).

## Standard

Skills follow the open Agent Skills format (`agentskills.io`), so a `SKILL.md` is portable across Claude Code, Codex, Cursor, Devin Desktop and other hosts. Summer adds a few optional frontmatter fields (`compatibility`, `category`, `allowed-tools`, `paths`); hosts ignore fields they do not know.
