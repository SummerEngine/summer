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
- No multiplayer setup yet: no `SummerNetworkWorld`, no `summer.build.json`, no `world.json`.

## Case 1: Happy Path — online co-op (2–4 players)

**Input:** "Add multiplayer to my game. Co-op for me and three friends."

**Expected sequence:**

1. The skill asks the three questions: purpose, players per match, and continuous motion versus discrete state. It waits.
2. The user confirms co-op, 4 players, and that player characters move continuously.
3. The skill states the plan: one `player` entity per player with a role-free domain script, predicted on its owner and interpolated for others; a headless authority scene; a `casual` queue; Local Play testing; no RPCs. It waits for OK.
4. After the OK:
   - `summer_get_scene_tree`
   - `summer_inspect_node "./World/Player"`
   - Write `components/multiplayer/player/player_domain.gd`, `player_presenter.gd`, `player_archetype.tres`, `authority_model.tscn`, `owner_projection.tscn` and `observer_projection.tscn`.
   - Write `network/network_root.tscn` (World, Entities, Spawner), `authority/main.tscn` and its script, and the client entry's `Summer.initialize` + `Summer.client.join(SummerJoinTarget.queue(&"casual"))`.
   - Write `summer.build.json` and `world.json`.
   - `summer_get_script_errors`
   - `summer_project_setting` for `summer/local_play/players`, plus the three `summer/local_play/network/*` settings.
   - `summer_play`, `summer_get_diagnostics`, `summer_stop`

**Assertions:**

- [ ] The skill asks its questions BEFORE any tool call.
- [ ] No `@rpc`, `MultiplayerSpawner`, `MultiplayerSynchronizer`, `ENetMultiplayerPeer`, `multiplayer.is_server()` or peer-ID branch appears anywhere.
- [ ] The domain script has no role branches. It implements `_summer_initial_state`, `_summer_collect_input`, `_summer_neutral_input`, `_summer_normalize_input`, `_summer_simulate` and `_summer_present`.
- [ ] `_summer_simulate` reads only its `input`, `state` and `delta` arguments.
- [ ] The archetype's field types match the values: `TYPE_VECTOR2` (5) for `move`, `TYPE_VECTOR3` (9) for `position`.
- [ ] Both projection `Domain` nodes set `interpolator` (a `SummerNetworkMotionInterpolator` naming `position`) **and** `presenter`. The authority scene has neither, and no visuals.
- [ ] The camera exists only in `owner_projection.tscn`.
- [ ] The Spawner sets `archetypes` and `player_archetype`; no code spawns players by hand.
- [ ] The authority scene initializes Summer and waits for the World's `binding_ready`.
- [ ] Local Play runs at least once with `round_trip_msec`, `jitter_msec` and `loss_percent` set.
- [ ] After play, the skill checks diagnostics on every process, and reports whether the owner's correction count stayed flat during steady movement.

## Case 2: Existing RPC multiplayer that rubberbands

**Input:** "My multiplayer game rubberbands. It uses @rpc and MultiplayerSynchronizer."

**Assertions:**

- [ ] The skill explains that hand-rolled RPC sync has no prediction or reconciliation, and proposes moving the player to a `SummerNetworkBehavior` entity.
- [ ] It does not tune the synchronizer's replication interval or add client-side smoothing on top of the RPC path.
- [ ] It removes the `MultiplayerSynchronizer` and `MultiplayerSpawner` nodes it replaces, with the user's confirmation.

## Case 3: Hitscan weapon

**Input:** "Players can shoot each other with a rifle."

**Assertions:**

- [ ] The skill configures `SummerNetworkHitHistory3D` on the Spawner (`max_view_age_msec = 250`, `retention_msec` set explicitly to 350, or at least 100 ms above the view age, `interpolation_delay_msec` not lowered below 100) and a `SummerNetworkHitbox3D` on the archetype.
- [ ] It fires with `enqueue_ray_command` from inside `_summer_collect_input`.
- [ ] No client-side raycast decides hits.

## Case 4: Peer-to-peer request

**Input:** "Make it peer-to-peer so we don't need a server."

**Assertions:**

- [ ] The skill states that Summer games always run a headless authority, so there is no peer-to-peer or host-migration mode, and routes to `skill/peer-to-peer-multiplayer` for the explanation.
- [ ] It does not build an `ENetMultiplayerPeer` host/join path.
