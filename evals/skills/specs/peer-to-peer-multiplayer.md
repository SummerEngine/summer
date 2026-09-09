---
spec: eval/skill-spec/peer-to-peer-multiplayer
skill: skill/peer-to-peer-multiplayer
status: ported
source: tests/specs/peer-to-peer-multiplayer.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /peer-to-peer-multiplayer

## Fixture

- A Summer Engine project that does not yet have multiplayer.
- Project may be empty or may have an existing single-player scene.
- Summer MCP tools available; engine running on localhost:6550.

## Case 1: Happy Path — fresh multiplayer architecture from scratch

**Input:** "I want to add 2-player co-op to my game. Players will connect through Steam friend invites."

**Expected behavior:**

1. Skill confirms P2P is the right architecture (Steam friend invite ≤8 players → P2P, not dedicated server).
2. Skill walks the four layers in order, checkpointing between each.
3. Layer 1: asks "May I create `autoloads/network_manager.gd`?" — creates it on user OK, calls `summer_project_setting` to register the autoload.
4. Layer 2: asks "May I create `autoloads/game_state.gd` and walk through the authority decision matrix?" — creates it, prompts user for game-specific state fields and proposes ownership.
5. Layer 3: explains the three RPC patterns with examples; doesn't auto-apply (this is reference material until concrete game logic exists).
6. Layer 4: defers prediction/interpolation until there's a player scene to apply it to.

**Expected MCP tool sequence (in order, partial):**

1. `summer_get_scene_tree` — see what already exists.
2. `summer_get_project_context` — read autoload list to avoid name collisions.
3. (User approves Layer 1) `Write autoloads/network_manager.gd`.
4. `summer_project_setting(key="autoload/NetworkManager", value="*res://autoloads/network_manager.gd")`.
5. (User approves Layer 2) `Write autoloads/game_state.gd`.
6. `summer_project_setting(key="autoload/GameState", value="*res://autoloads/game_state.gd")`.
7. `summer_save_scene` and `summer_get_script_errors` to verify clean.

**Assertions:**

- [ ] Skill explicitly checks Step 0 (P2P vs. client-server) before any code is written.
- [ ] Skill creates Layer 1 (NetworkManager) before Layer 2 (GameState).
- [ ] NetworkManager is the only place that calls `multiplayer.peer_connected.connect()` directly. GameState listens to NetworkManager signals, NOT to the multiplayer API directly.
- [ ] GameState uses `@rpc("authority", "call_remote", "reliable")` for host-broadcast functions and `@rpc("any_peer", "call_remote", "reliable")` with a `is_host` guard for client-request functions.
- [ ] Skill walks the user through the authority decision matrix before writing GameState. Doesn't dump generic state fields without asking what the game has.
- [ ] Skill asks "May I…" before each new file creation and before the autoload registration.
- [ ] Skill does NOT apply prediction/interpolation in Layer 4 unless there's an existing player scene to wire into.
- [ ] At any layer, `summer_get_script_errors` is called after the file write to confirm clean compile.

## Case 2: Failure Path — user wants matchmaking at scale

**Input:** "I'm building a competitive shooter. I want matchmaking with anti-cheat for 10,000 concurrent matches."

**Expected behavior:**

- Skill recognizes Step 0: this is dedicated client-server territory, not P2P.
- Skill explains why P2P is wrong (host can cheat, no anti-cheat hooks, scale concerns).
- Skill defers to `/summer:client-server-multiplayer` (when shipped) OR explains the user needs to roll a custom server.
- Does NOT start writing P2P NetworkManager code anyway.

**Assertions:**

- [ ] Skill stops at Step 0 — does NOT proceed to Layer 1.
- [ ] Skill explains the architecture mismatch in one sentence.
- [ ] Skill names the right alternative (client-server) and which skill to use instead.

## Case 3: Edge Case — retrofitting multiplayer to a single-player game

**Input:** "I have a single-player platformer that's mostly done. Can you add multiplayer?"

**Expected behavior:**

- Skill is honest about the cost: retrofitting multiplayer is 5× harder than starting MP-first.
- Skill asks: "Are you committed? It will require auditing every state mutation in your existing code. Time estimate: significant."
- If user proceeds: skill walks the same 4 layers but adds an AUDIT phase before Layer 2: identify every place existing code writes to state that should be host-authoritative.
- If user balks: skill points to alternatives (release MP as a sequel; ship single-player; add async leaderboards instead).

**Assertions:**

- [ ] Skill warns about retrofit cost BEFORE starting Layer 1.
- [ ] Skill adds an AUDIT step that doesn't exist in the happy-path workflow.
- [ ] Skill never silently proceeds as if the game were greenfield.

## Case 4: No Summer MCP — fallback path

**Fixture:** Same as Case 1, but Summer MCP unavailable.

**Input:** "Add multiplayer to my Summer game (P2P, friend invite)."

**Expected behavior:**

- Skill detects MCP unavailable.
- Walks the same 4 layers.
- Instead of `summer_project_setting`, asks the user to manually edit `project.godot`'s `[autoload]` section — provides the exact lines to paste.
- Instead of `summer_save_scene` / `summer_get_script_errors`, asks the user to
  save and check errors manually in Summer Engine.
- All file writes still go through `Write` host tool with "May I…" approval per file.

**Assertions:**

- [ ] Skill detects MCP unavailable; doesn't blindly call `summer_*` tools and fail.
- [ ] Project.godot edits are provided as exact paste-able lines.
- [ ] Workflow shape (4 layers, checkpoints between) is identical regardless of MCP availability.

---

This spec runs via `/skill-test peer-to-peer-multiplayer spec` (see `workflow/skill-test/SKILL.md`).
