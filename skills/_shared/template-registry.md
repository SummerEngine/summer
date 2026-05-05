# Template Registry

> Skills cross-link to template repos via the `template-id` frontmatter field. This file is the canonical mapping. When a template repo moves, update one entry here.

## Template IDs

| template-id | Description | Repo |
|---|---|---|
| `template-3d-fps` | First-person shooter starter (CharacterBody3D, Camera3D, input, sample level) | https://github.com/SummerEngine/FPS-template-Summer-Engine |
| `template-3d-tps` | Third-person shooter starter | https://github.com/SummerEngine/tps-template |
| `template-2d-platformer` | 2D platformer starter (TileMap, CharacterBody2D, parallax) | TBD |
| `template-3d-platformer` | 3D platformer starter (jump, double jump, simple level) | TBD |
| `template-top-down-rpg` | Top-down ARPG starter | TBD |
| `template-2d-deckbuilder` | Deck-builder starter (card, deck, draw, discard, energy) | TBD (prototype lives at `templates/template-2d-deckbuilder/`) |
| `template-tower-defense` | Tower defense starter | TBD |
| `template-walking-sim` | Walking sim starter | TBD |

## Convention

Each template is its own GitHub repo, MIT licensed, kept small (< 50 MB). Templates ship working code. Skills describe patterns. A skill links to the matching template via:

```markdown
## Want a working starter?

This skill describes the pattern. For a runnable project, use the template:

→ **template-id**: `template-3d-fps`
→ **Repo**: https://github.com/SummerEngine/FPS-template-Summer-Engine
→ **Bootstrap**: `summer template clone template-3d-fps my-fps`
```

## Linter check

The `_meta/skill-test/SKILL.md` static linter validates that any `template-id:` declared in a skill's frontmatter exists in the table above.

## Adding a template

1. Create a new GitHub repo under `SummerEngine` org, MIT license.
2. Add the `template-id`, description, and repo URL to the table above.
3. Reference the `template-id` from any relevant skill.
