# Skill Spec: /host-authoritative-state

## Fixture

- Summer Engine project with a working multiplayer setup from `/setup-multiplayer`: `SummerNetworkWorld`, `SummerNetworkSpawner`, `summer.build.json`, `world.json` and an authority scene.
- A shop: players spend coins to buy items, and everyone sees a shared stock count.
- Summer MCP tools and host file tools available.

## Case 1: Happy Path — a shop with private wallets and shared stock

**Input:** "Players should be able to buy items. Each player has coins; the shop's stock is shared."

**Expected sequence:**

1. The skill lists the state and its owner: stock shared (authority-written, world audience), wallets private (authority-written, target-session audience), buying a Command. It states this before writing code.
2. After the OK:
   - Write one shared composition script used by client and authority (a world-audience stream, a target-session stream, and a world-scoped Command stream with payload and result schemas).
   - Write the authority's `command_received` handler.
   - Write the client's `enqueue_command` call and its `state_group_created` handler.
   - `summer_get_script_errors`
   - `summer_project_setting` for `summer/local_play/players`, `summer_play`, `summer_get_diagnostics`, `summer_stop`.

**Assertions:**

- [ ] No `@rpc`, `MultiplayerSynchronizer`, synced variables or peer-ID checks.
- [ ] Client and authority build the composition from the same script.
- [ ] The authority reads identity from `request.get_session().player.user_id`, never from the payload.
- [ ] Every Command carries a request id, and the authority answers a repeated id with the stored result without applying it again.
- [ ] Refusals use stable reason ids (`request.refuse(&"...")`), and preconditions are checked before any state changes.
- [ ] State changes only through authority-written groups (`reset`); the client never edits its copy.
- [ ] Documents travel as `TYPE_PACKED_BYTE_ARRAY`, not `String`.
- [ ] Audience bounds (`max_expansion`, `max_audience_count`) are set: at least the player count, or 1 for private streams.
- [ ] The client connects `state_group_created` before joining, and reads `group.get_state()` in that handler before relying on `state_installed`.

## Case 2: "Sync the player's health with an RPC"

**Input:** "Add health and sync it to everyone with an RPC when it changes."

**Assertions:**

- [ ] The skill puts health in an authority-written State group, not an RPC.
- [ ] Damage reaches health only through the authority: a Command, or the authority's own hit resolution.

## Case 3: Movement routed elsewhere

**Input:** "Players' positions keep desyncing."

**Assertions:**

- [ ] The skill routes continuous motion to `skill/setup-multiplayer` (`SummerNetworkBehavior`) instead of putting positions in State groups or Commands.
