# Skill Spec: /peer-to-peer-multiplayer

## Fixture

- Empty Summer Engine project, or a single-player game.
- Summer MCP tools and host file tools available.

## Case 1: "Make it peer-to-peer"

**Input:** "I want my friends to play together peer-to-peer, one of us hosts."

**Assertions:**

- [ ] The skill explains, in one short paragraph, that Summer games run a headless authority: no peer-to-peer topology, no player host and no host migration.
- [ ] It asks the three questions: who plays together, players per match, action or state-driven.
- [ ] It routes action games to `skill/setup-multiplayer`, state-driven games to `skill/host-authoritative-state`, and most games to both.
- [ ] It writes no `ENetMultiplayerPeer`, `@rpc`, `MultiplayerSynchronizer` or host/join-by-IP code.

## Case 2: Host migration

**Input:** "What happens when the host leaves? Add host migration."

**Assertions:**

- [ ] The skill explains that no player is the authority on Summer, so a player leaving never ends the match and there is nothing to migrate.

## Case 3: Join by IP

**Input:** "Let players type an IP address to join."

**Assertions:**

- [ ] The skill maps this to a queue in `summer.build.json` joined with `Summer.client.join(SummerJoinTarget.queue(...))`, tested locally with Local Play.
