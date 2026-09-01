# Skill-spec coverage gaps

## TBD stubs (spec file exists in `tests/specs/`, content never written)

| Skill | Old stub | Why it matters |
|---|---|---|
| skill/3d-lighting | tests/specs/3d-lighting.md | High-traffic ("lighting looks flat" class of asks) |
| skill/asset-strategy | tests/specs/asset-strategy.md | The routing skill for all asset work — a misroute here cascades |
| skill/gdscript-patterns | tests/specs/gdscript-patterns.md | Touches every script the agent writes |
| skill/make-game | tests/specs/make-game.md | THE orchestration spine; also the end-to-end ladder anchor (`evals/end-to-end/`) |
| skill/scene-composition | tests/specs/scene-composition.md | Structural conventions every scene mutation relies on |
| skill/ui-basics | tests/specs/ui-basics.md | Every HUD/menu request |

Stubs were NOT ported — porting a 19-line TBD adds noise, not coverage. Write
the spec content first (format in `README.md`), then land it as
`specs/<slug>.md` with `status: ported`.

## Skills with no spec at all (58 of 79)

Everything not listed above or present in `specs/`. Highest-value next specs,
by user traffic and blast radius:

1. skill/create-asset-sheet — most complex 2D pipeline, many failure modes
2. skill/character-model — gated rig pass, user-approval checkpoints
3. skill/debug's siblings: skill/investigating-bugs, skill/debugging-game-feel
4. skill/setup-multiplayer companions already covered; skill/remote-deploy is not
5. The 8 VFX recipes (fire, smoke, ...) — mechanical, cheap to spec, cheap to verify
