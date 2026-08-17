# Template Registry

> Skills cross-link to template repos via the `template-id` frontmatter field.
>
> **This file is a convenience snapshot, not the source of truth.** Templates are discovered live from the GitHub org, so this table goes stale the moment a template is added. Ask the CLI instead:
>
> ```bash
> summer list templates
> ```

## How discovery actually works

`summer list templates` queries `github.com/SummerEngine` for repos named `template-*`, and **strips the `template-` prefix to produce the slug** (`src/lib/remote-templates.ts`). So the repo `template-2d-platformer` is created with:

```bash
summer create 2d-platformer my-game
```

There is no `summer template clone` command. `summer create <slug> [dir]` is the only bootstrap path, and it takes the stripped slug, not the repo name.

## Snapshot — verified against `summer list templates`

Built-in, no download required:

| slug | Description |
|---|---|
| `empty` | Empty 3D project with just a root node |
| `3d-basic` | 3D scene with camera, light, and floor |

Community templates, all at `https://github.com/SummerEngine/template-<slug>`:

| slug | Description |
|---|---|
| `2d-brario-platformer` | 2D platformer starter |
| `2d-grid-puzzle` | Grid-based puzzle starter |
| `2d-plants-and-zombies-tower-defense` | Lane tower-defense starter |
| `2d-platformer` | 2D platformer starter (TileMap, CharacterBody2D, parallax) |
| `2d-rpg` | 2D top-down RPG starter (built on GDQuest's open-source work) |
| `2d-vampire-survivor-roguelike` | Survivors-like roguelike starter |
| `3d-fps-old-school` | Retro first-person shooter starter |
| `3d-fps-simple-animated-npc` | FPS starter with an animated NPC |
| `3d-lan-multiplayer-starter` | 3D LAN multiplayer starter (built on GDQuest's open-source work) |
| `3d-open-world-explore-tps` | Third-person open-world exploration starter |
| `3d-racing-game` | Racing starter |
| `3d-royale-clash-type` | Auto-battler / lane-pusher starter |
| `3d-third-person-controller` | 3D third-person character controller (built on GDQuest's open-source work) |
| `3d-voxel-sandbox` | Voxel sandbox (chunked world, face culling, mining/building, seeded gen) |

If a slug you expect is missing here, it is this file that is out of date, not the CLI. Run `summer list templates`.

## Convention

Each template is its own GitHub repo under the `SummerEngine` org, MIT licensed, kept small (< 50 MB), and named `template-<slug>`. Templates ship working code; skills describe patterns. A skill links to the matching template via:

```markdown
## Want a working starter?

This skill describes the pattern. For a runnable project, use the template:

→ **template-id**: `template-2d-platformer`
→ **Repo**: https://github.com/SummerEngine/template-2d-platformer
→ **Bootstrap**: `summer create 2d-platformer my-game`
```

## Linter check

The `workflow/skill-test/SKILL.md` static linter validates that any `template-id:` declared in a skill's frontmatter exists in the table above. Because the table is a snapshot, a linter failure may mean the table is stale rather than the skill being wrong — check `summer list templates` before editing the skill.

## Adding a template

1. Create a new repo under the `SummerEngine` org named `template-<slug>`, MIT license.
2. It appears in `summer list templates` automatically — no registration step.
3. Add it to the snapshot above and reference the `template-id` from any relevant skill.
