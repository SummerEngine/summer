---
spec: eval/skill-spec/setup-multiplayer
skill: skill/setup-multiplayer
status: ported
source: tests/specs/setup-multiplayer.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /setup-multiplayer

## Fixture

- Summer Engine project, single-player game with `World/Player` (CharacterBody3D) and a working camera + movement script.
- Summer MCP tools available.
- Host file tools available (Read, Edit, Write).
- No multiplayer setup yet (no autoloads, no MultiplayerSpawner, no Synchronizer).

## Case 1: Happy Path — co-op LAN (2–4 players)

**Input:** "Add multiplayer to my game. Co-op for me and three friends."

**Expected MCP tool sequence (in order):**

1. (Skill asks the four blocking questions — type / count / authority / network — and waits.)
2. User confirms: co-op online, 4 players, host one of the players, public internet.
3. (Skill explicitly states the locked decision: "Going with **host authority**, ENet transport, 30 Hz input / 20 Hz position. Refactoring authority later is brutal — confirm.")
4. After user OK:
   - `summer_get_scene_tree`
   - `summer_inspect_node "./World/Player"`
   - `Write scripts/network.gd` (autoload)
   - `summer_project_setting(name="autoload/Network", value="*res://scripts/network.gd")`
   - `summer_add_node(parent="./World/Players/Player", type="MultiplayerSynchronizer", name="Sync")` (or the equivalent on the player scene)
   - SceneReplicationConfig saved as standalone `.tres` (NOT inline)
   - `Write scripts/player_net.gd`
   - `summer_save_scene`
   - `summer_get_script_errors`

**Assertions:**

- [ ] Skill asks all four blocking questions BEFORE any tool call.
- [ ] Skill explicitly names the authority model (host) and gets a confirmation before mutating.
- [ ] Skill picks ENet (NOT custom transport, NOT WebRTC).
- [ ] Generated script uses `MultiplayerSpawner` pattern (host spawns, clients receive).
- [ ] Player script disables `_physics_process` for non-local peers.
- [ ] Camera is local-only (`camera.current = is_local`).
- [ ] Damage RPC checks `multiplayer.is_server()` before applying.
- [ ] At least one `any_peer` RPC validates `get_remote_sender_id()`.
- [ ] SceneReplicationConfig is a standalone `.tres`, NOT inline sub_resource.
- [ ] Skill does NOT replicate cosmetic VFX or local UI.
- [ ] Final step is `summer_save_scene` then `summer_get_script_errors`.

## Case 2: Failure Path — user wants competitive PvP without dedicated server

**Input:** "Add competitive PvP for 8 players, hosted by one of them, with anti-cheat."

**Expected behavior:**

- Skill names the conflict: "Anti-cheat with host-authority is fundamentally broken — the host can always cheat. For competitive PvP at this scale, you need a dedicated server. Want me to scaffold that path (different code, different deploy story), or are we doing trusted-host co-op-style PvP?"
- Does NOT silently scaffold host-authority code that the user thinks has anti-cheat.
- Does NOT scaffold dedicated-server code without explicit confirmation (different complexity).

**Assertions:**

- [ ] Skill flags the architectural impossibility, not just "this is hard".
- [ ] Skill names the trade-off explicitly (host = host can cheat; dedicated = ops cost).
- [ ] Skill stops to ask before generating any code.
- [ ] Skill does NOT just pick host-authority because it's the default.

## Case 3: Edge Case — user says "let's also do rollback netcode for our co-op"

**Fixture:** Same as Case 1.

**Input:** "Add multiplayer with rollback netcode so we don't see lag."

**Expected behavior:**

- Skill calls out: "Rollback netcode is a 6-month project on its own and is the right answer for fighting games / lock-step RTS, not co-op. For co-op, host authority + smooth interpolation gives you 95% of the perceived smoothness for 5% of the work. Want me to scaffold the standard host model?"
- Does NOT start scaffolding rollback.
- Does NOT silently downgrade to host-authority — names the choice and the trade-off.

**Assertions:**

- [ ] Skill names rollback as wrong-tool-for-job for co-op.
- [ ] Skill names the standard alternative (host authority + interpolation).
- [ ] Skill stops to confirm before scaffolding.
- [ ] Skill points to specialist skill for lag compensation if user insists on competitive shooter.

## Case 4: No Summer MCP — fallback path

**Fixture:** Same as Case 1, but Summer MCP unavailable.

**Input:** "Add co-op multiplayer for 4 players."

**Expected behavior:**

- Skill detects MCP unavailable.
- Asks the user to paste their existing main scene `.tscn` so the autoload + spawn paths reference real nodes.
- Asks the user to paste `project.godot` so the autoload entry can be added by hand.
- Writes `scripts/network.gd` + `scripts/player_net.gd` directly via host file tools.
- Provides a manual `project.godot` patch (autoload entry + replication config path) as text the user can paste.
- Provides scene-editor instructions for adding the MultiplayerSynchronizer + setting up replication properties.
- Still asks "May I write …" before each file write.

**Assertions:**

- [ ] Skill does not blindly call `summer_*` tools and fail.
- [ ] Generated scripts compile in the current Summer Engine compatibility line.
- [ ] Skill provides a `project.godot` patch in valid Godot project format.
- [ ] Skill still asks for confirmation on each write.
- [ ] Same opinionated decisions hold (host authority, ENet, no replication of cosmetic VFX).

---

This spec runs via `/skill-test setup-multiplayer spec` (see `workflow/skill-test/SKILL.md`).
