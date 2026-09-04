# Template repos — fast-forward list (2026-09-04)

Fourteen template repositories were fixed on branch `fix/truth-pass-2026-09-04` (see `TEMPLATES-PRISTINE-BOOT-2026-09-03.md` for the sweep that found the problems). The toolkit pins (`library/templates/*/resource.yaml`) already point at these branch commits; GitHub serves any reachable SHA, so `summer create` works today. **Do not delete the fix branches until each default branch has been fast-forwarded.**

Note the default branch names: three repos do not use `main`.

Preconditions before fast-forwarding a repo whose `.gitignore` stopped ignoring `*.import` (brario, fps-simple-animated-npc, voxel-sandbox, grid-puzzle, fps-old-school): run one `--headless --import` pass on a checkout of the branch and commit the generated `*.import` files, otherwise every clone re-imports with fresh uids (harmless but non-deterministic).

Each command is a fast-forward only (fails if not ff):

```
gh api -X PATCH repos/SummerEngine/template-2d-brario-platformer/git/refs/heads/main -f sha=cf7426cdd48f243e501396530ccaf8549c4951ad
gh api -X PATCH repos/SummerEngine/template-2d-grid-puzzle/git/refs/heads/main -f sha=f8433fddeb63f2e62db05fd84cf0516cea49431d
gh api -X PATCH repos/SummerEngine/template-2d-plants-and-zombies-tower-defense/git/refs/heads/main -f sha=83e79fa573986973aef590cebed290f097de339e
gh api -X PATCH repos/SummerEngine/template-2d-rpg/git/refs/heads/main -f sha=4de2331a0495ae90e60b3f7fa933d8cc2b027a7c
gh api -X PATCH repos/SummerEngine/template-2d-vampire-survivor-roguelike/git/refs/heads/main -f sha=53197b89710d2212a3b9e117e59cfe897db1e2af
gh api -X PATCH repos/SummerEngine/template-3d-city-kit/git/refs/heads/codex%2Fimportable-template -f sha=2635fc8372435940e6b7415934fe0c2896c8c967
gh api -X PATCH repos/SummerEngine/template-3d-fps-old-school/git/refs/heads/bror-templates -f sha=5a1ef4b86a900f72607cfa755fb38afc3163bcc6
gh api -X PATCH repos/SummerEngine/template-3d-fps-simple-animated-npc/git/refs/heads/main -f sha=b987a48aa7331a44189d9103040fc37a328b81ee
gh api -X PATCH repos/SummerEngine/template-3d-lan-multiplayer-starter/git/refs/heads/main -f sha=f4207b6462ad887c1d727078b67302179908012d
gh api -X PATCH repos/SummerEngine/template-3d-open-world-explore-tps/git/refs/heads/main -f sha=d832fa0b5574d154ac85020ab8b7646174915b11
gh api -X PATCH repos/SummerEngine/template-3d-racing-game/git/refs/heads/main -f sha=8305f5e68a5888e0f6053ca8ef5d7a0bd041aa79
gh api -X PATCH repos/SummerEngine/template-3d-royale-clash-type/git/refs/heads/main -f sha=251185d4b5d79e183336792b4f021349a2954128
gh api -X PATCH repos/SummerEngine/template-3d-third-person-controller/git/refs/heads/master -f sha=694b6ae5eb9f4fc4df1f60b20d57aab82e94216a
gh api -X PATCH repos/SummerEngine/template-3d-voxel-sandbox/git/refs/heads/main -f sha=2b31cf12761b2d00d5268c2056d0c0706f6ad54e
```

Already fast-forwarded: `template-2d-platformer` main → `ad9d6304` (2026-09-04). Untouched: `3d-procedural-road-world` (nothing wrong), `2d-dungeon-roguelike` (private repo; installs only with local git credentials).

Human calls left open by the truth pass: four `template.json` ids differ from toolkit ids (fps-npc `fps-combat-slice`, pvz `2d-lane-defense`, vampire `2d-survivors-roguelike`, open-world `third-person-adventure-slice`), probably web-platform keys; `top-down` and `card-game` are not in the domain vocabulary; tracked non-local `.summer/` docs in six repos; a 1.2 MB unreferenced download and dev leftovers in vampire.
