---
spec: eval/skill-spec/host-authoritative-state
skill: skill/host-authoritative-state
status: ported
source: tests/specs/host-authoritative-state.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /host-authoritative-state

## Fixture

- A Summer Engine project with `/peer-to-peer-multiplayer` Layer 1 already done. `NetworkManager` autoload exists and exposes `peer_joined` / `peer_left` signals.
- Project may have a partial player scene; no Managers yet.
- Summer MCP tools available; engine on localhost:6550.

## Case 1: Happy Path — design HealthManager from scratch with full ownership audit

**Input:** "I want to add health, damage, and a kill counter to my multiplayer game. Help me set it up correctly."

**Expected behavior:**

1. Skill confirms `NetworkManager` already exists; if not, defers to `/peer-to-peer-multiplayer`.
2. Skill walks the user through the fundamental question on each new field: `health`, `max_health`, `score`, `kills`. All four → host-owned.
3. Skill proposes one Manager per domain — `HealthManager` for health/max_health, `ScoreManager` for score/kills. Asks before creating each.
4. For `HealthManager`, skill walks the canonical shape:
   - Data dict keyed by `peer_id`.
   - `_host_apply_damage()` mutator with `if not NetworkManager.is_host: return` first line.
   - `_client_request_damage()` RPC with `@rpc("any_peer", "call_remote", "reliable")` and validation (range, line-of-sight, cooldown, magnitude).
   - `_broadcast_health()` and `_broadcast_death()` with `@rpc("authority", "call_remote", "reliable")`.
   - `peer_joined` registers, `peer_left` cleans up.
5. After file write, `summer_get_script_errors` to verify clean compile.

**Expected MCP tool sequence (partial):**

1. `summer_get_scene_tree` — confirm NetworkManager autoload presence.
2. `Read autoloads/network_manager.gd` — confirm signals match expected shape.
3. (User approves HealthManager) `Write autoloads/HealthManager.gd`.
4. `summer_get_script_errors` to verify.
5. (User approves ScoreManager) repeat.

**Assertions:**

- [ ] Skill applies the fundamental question explicitly to each field — does not silently dump generic state.
- [ ] Skill proposes one Manager per domain, not one mega-Manager for all state.
- [ ] Every `_host_apply_*` function's first line is `if not NetworkManager.is_host: return`.
- [ ] Every `_client_request_*` is `@rpc("any_peer", "call_remote", "reliable")` and has at least three validators.
- [ ] Every `_broadcast_*` is `@rpc("authority", "call_remote", "reliable")`.
- [ ] `peer_joined` and `peer_left` lifecycle is wired in `_ready()`.
- [ ] Skill does NOT use `MultiplayerSynchronizer` for any health/score field.
- [ ] Skill asks "May I…" before each new file creation.

## Case 2: Late-join state sync

**Input:** "I have HealthManager working but new players who join mid-match see 100 HP for everyone, even players who are at 30 HP. Fix it."

**Expected behavior:**

- Skill identifies the bug: no late-join state replay.
- Skill explains the pattern: `_send_full_state(peer_id)` method on each Manager, called from `peer_joined`, uses `rpc_id` (flavor 4) to target only the joining peer.
- Skill audits all existing Managers for missing `_send_full_state` and adds it.
- Skill verifies idempotency — receiving a broadcast twice for the same peer must be a no-op.

**Assertions:**

- [ ] Skill diagnoses the missing late-join replay before writing code.
- [ ] Skill uses `rpc_id(target_peer, ...)` (flavor 4), NOT a broadcast to all peers.
- [ ] Skill audits ALL existing Managers, not just HealthManager — score, inventory, cooldowns all need the same fix.
- [ ] Skill checks that broadcast handlers are idempotent before shipping.
- [ ] `summer_get_script_errors` runs after each file edit.

## Case 3: Edge — client wants to lie about position (client-predicted)

**Input:** "A peer reports another player is teleporting around the map. I added validation to `_client_request_position()` and it blocks legitimate movement. What do I do?"

**Expected behavior:**

- Skill identifies the user has put `position` into the wrong column. Position is **host-authoritative with client prediction**, not pure host-owned.
- Skill explains: clients send their input/intent (movement direction + jump), not their final position. Host runs the same physics function authoritatively. If host's computed position diverges from client's reported position by more than a tolerance, host snaps the client (reconciliation).
- Skill removes the `_client_request_position` validator and points to `/peer-to-peer-multiplayer` Layer 4 for the prediction/reconciliation pattern.
- Skill notes that "blocking" position requests defeats the point of prediction — it would make movement feel terrible. The right response to a divergent client is reconciliation, not rejection.

**Assertions:**

- [ ] Skill recognizes position is the "Sometimes" category from the fundamental question, not pure host-owned.
- [ ] Skill defers reconciliation logic to `/peer-to-peer-multiplayer` Layer 4 instead of inventing a new pattern.
- [ ] Skill does NOT propose validating each position update with range/distance checks — that's the wrong tool.
- [ ] Skill explains why teleport-cheating is caught by reconciliation, not rejection.

## Case 4: No Summer MCP — fallback path

**Fixture:** Same as Case 1, but Summer MCP unavailable.

**Input:** "Add a HealthManager autoload to my multiplayer game."

**Expected behavior:**

- Skill detects MCP unavailable.
- Walks the same Manager shape (data, mutators, requests, broadcasts, lifecycle).
- Instead of `summer_get_script_errors`, asks the user to save and check errors
  manually in Summer Engine.
- Provides exact `[autoload]` lines for `project.godot` to paste.
- File write still goes through `Write` host tool with "May I…" approval.

**Assertions:**

- [ ] Skill detects MCP unavailable; doesn't blindly call `summer_*` tools and fail.
- [ ] `project.godot` autoload lines are provided as exact paste-able text.
- [ ] Manager shape (5-part: data / mutators / requests / broadcasts / lifecycle) is identical regardless of MCP availability.

---

This spec runs via `/skill-test host-authoritative-state spec` (see `workflow/skill-test/SKILL.md`).
