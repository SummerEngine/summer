---
name: multiplayer-testing
description: "Test a Summer multiplayer game with Local Play: several players, a bad network, bots, and what a passing run shows."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: multiplayer-and-networking
user-invocable: true
allowed-tools: Read Grep Edit Write summer_project_setting summer_play summer_stop summer_get_diagnostics summer_get_console summer_screenshot
paths: ["project.godot", "summer.build.json", "client/**", "authority/**", "network/**"]
---

# /multiplayer-testing — prove it works before saying it works

Step 4 of the multiplayer sequence (`multiplayer` explains the model).

**Local Play** runs a Summer multiplayer game on one machine. It starts the
World's authority scene headless and N clients, and each client joins through
the game's own `Summer.client.join`. No account, server or extra tools are
needed. It can also make the network bad on purpose, which is where
multiplayer bugs show.

## 1. Start Local Play

Pick whichever the session has.

**Summer MCP tools** (they set project settings, then play):

```
summer_project_setting name="summer/local_play/players" value=2
summer_play
summer_get_diagnostics
summer_stop
```

**Editor:** **Debug > Local Multiplayer**, pick the player count, press Play.
The client windows tile side by side.

**Terminal** (`<summer>` is the Summer editor executable). Import once after
adding scripts so their classes register:

```sh
<summer> --headless --path . --import
<summer> --path . --summer-local-play 2 --summer-local-play-timeout 30
```

| Setting | Terminal flag | Meaning |
|---|---|---|
| `summer/local_play/players` | `--summer-local-play <n>` | Players to start. `-1` uses the queue's `minPlayers`; `0` turns Local Play off |
| `summer/local_play/queue` | `--summer-local-play-queue <name>` | Which `summer.build.json` queue to stand in for (default: the first) |
| — | `--summer-local-play-headless` | Run the clients without windows too |
| — | `--summer-local-play-timeout <s>` | End the session after that many seconds |
| — | `--summer-local-play-smoke` | Headless clients; exit 0 once every client joined and stayed 3 s |
| — | `--summer-local-play-spectators <n>` | Also start spectator clients |
| — | `--summer-local-play-web` | Run the clients in a browser (the game's Web export) |

## 2. Make the network bad

Loopback has no latency, so it hides every timing bug. Always run once with
these settings; they apply to every client:

```
summer_project_setting name="summer/local_play/network/round_trip_msec" value=100
summer_project_setting name="summer/local_play/network/jitter_msec" value=10
summer_project_setting name="summer/local_play/network/loss_percent" value=1
```

Or put them in `project.godot` while testing:

```ini
[summer]

local_play/network/round_trip_msec=100
local_play/network/jitter_msec=10
local_play/network/loss_percent=1
```

Ranges: round trip 0–2000 ms, jitter 0–1000 ms, loss 0–50 %. Each client
prints `NETWORK_EMULATION round_trip_ms=100 ...` when it applies. Try 200 ms
too: that is a player on another continent.

## 3. Read the run

Every output line is prefixed by its process: `[authority]`, `[player-1]`,
`[player-2]`. The last line is the summary:

```text
SUMMER_LOCAL_PLAY_RESULT {"ok":true,"players":2,"network":{...},"processes":[{"label":"authority","script_errors":0,...},{"label":"player-1","joined":true,"script_errors":0,...}],...}
```

A run passes only when **all** of these hold:

- [ ] `"ok":true`, and every process has `"script_errors":0`.
- [ ] The game's own ready lines appear: the authority's, and one per client after its `join` Command (`COURTYARD_AUTHORITY_READY`, `COURTYARD_CLIENT_JOINED` in the Courtyard example). Print one in your game too.
- [ ] No `[SummerNetworkSpawner] cannot attach` warning on any process.
- [ ] No `SCRIPT ERROR` lines.

`"ok":true` alone only proves that clients got seats. If the composition is
invalid, the Spawner logs `cannot attach` as a warning and nothing networked
works, yet every client still counts as joined. The smoke flag
(`--summer-local-play-smoke`) proves the same thing and no more.

With MCP, `summer_get_diagnostics` reports runtime errors from the debugger.
Read it after every play; `summer_get_console` alone misses them.

## 4. Drive the game with bots

To test gameplay without hands, give the game a bot mode. Arguments after
`--` reach every process, and `{client}` becomes 1, 2, ... for players and 0
for the authority:

```sh
<summer> --path . --summer-local-play 2 --summer-local-play-headless --summer-local-play-timeout 20 -- --bot={client}
```

Put the bot in `client/bot.gd`. It presses the same input actions a player
does, so it tests the real controls:

```gdscript
extends Node
## Test bot for Local Play, enabled with `-- --bot={client}`. It presses the
## real input actions. Bot 1 walks to the first coin and collects it; every
## bot prints what it sees, for the test run to check.

const COIN := "0"

var number := 0
var main: Node
var elapsed := 0.0
var step := 0


func _process(delta: float) -> void:
	elapsed += delta
	var me := _own_player()
	if me == null:
		return
	if number == 1 and step == 0:
		var at: Array = main.match_doc.get("coins", {}).get(COIN, [])
		if at.is_empty():
			return
		var to_coin := Vector2(at[0] - me.global_position.x, at[2] - me.global_position.z)
		if to_coin.length() > 0.5:
			_steer(to_coin.normalized())
			return
		_steer(Vector2.ZERO)
		step = 1
		print("BOT_MOVED %s" % me.global_position)
		var collected: Dictionary = await main.collect(COIN)
		print("BOT_COLLECT %s" % JSON.stringify(collected))
	if elapsed > 6.0 and step < 2:
		step = 2
		for node in main.get_node("Entities").get_children():
			if node != me:
				print("BOT_SAW %s" % node.global_position)
		print("BOT_SCORES %s" % JSON.stringify(main.match_doc.get("scores", {})))


func _own_player() -> Node3D:
	for node in main.get_node("Entities").get_children():
		if node.get_script() == preload("res://client/player_owner.gd"):
			return node
	return null


func _steer(direction: Vector2) -> void:
	for action in [&"ui_left", &"ui_right", &"ui_up", &"ui_down"]:
		Input.action_release(action)
	if direction.x > 0.0: Input.action_press(&"ui_right", direction.x)
	if direction.x < 0.0: Input.action_press(&"ui_left", -direction.x)
	if direction.y > 0.0: Input.action_press(&"ui_down", direction.y)
	if direction.y < 0.0: Input.action_press(&"ui_up", -direction.y)
```

Add it from `client/main.gd` only when the argument is there, after the
player has joined:

```gdscript
	# Local Play test bot: `-- --bot={client}` (see multiplayer-testing).
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--bot="):
			var bot := preload("res://client/bot.gd").new()
			bot.number = int(arg.trim_prefix("--bot="))
			bot.main = self
			add_child(bot)
```

Then check the lines it prints. The Courtyard bot walks player 1 to a coin
and collects it; player 2 watches:

- [ ] `[player-1] BOT_MOVED` and `[player-2] BOT_SAW` report the same position (the observer is up to 100 ms behind while moving, then equal).
- [ ] `[player-1] BOT_COLLECT {"ok":true...}` and both players print the new score.

Keep bot code in `client/`: files under `test/` or other debug folders are
left out of the players' pack, so the shipped game could not load them.

Headless clients have no real window. Guard calls that need one (mouse
capture, window size) with `DisplayServer.get_name() != "headless"`.

## 5. What Local Play cannot show

- **Hosted-only services** answer with an error code locally: parties,
  friends, World chat, the store, client leaderboards and analytics. Their
  skills list the codes. Make the UI hide or explain them; never crash on them.
- **Matchmaking's accept prompt.** Local Play seats players directly: no
  proposal, one World per queue.
- **A player leaving for good.** A client that quits or calls
  `Summer.client.leave()` only disconnects. `session_disconnected` fires and
  their seat is held. `session_left` arrives when the World ends; hosted, it
  arrives when Summer ends the Session.
- **Real devices, real accounts, real distances.** Publish to staging for that
  (`multiplayer-publish`).

## Checklist for any multiplayer change

- [ ] Ran Local Play with at least 2 players, and once with 100 ms / 10 ms / 1 %.
- [ ] Every process: no `SCRIPT ERROR`, no `cannot attach`, `script_errors` 0.
- [ ] The game's own ready lines appear for the authority and every client.
- [ ] Your own player responds instantly and never snaps while moving normally.
- [ ] Other players move smoothly and end where their owners are.
- [ ] Shared state matches on every client; private state reaches only its owner.
- [ ] A refused Command changes nothing and shows its reason.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Test only on loopback | Add round trip, jitter and loss | Latency bugs are invisible at 0 ms |
| Read `"ok":true` as success | Also check your ready lines, `cannot attach` and `script_errors` | A broken composition still joins |
| Read only `summer_get_console` | `summer_get_diagnostics` after each play | Runtime errors live in the debugger |
| Put bot or test code under `test/` and load it from the game | Keep the bot in `client/`, enabled by `--bot` | Debug folders are left out of the players' pack |
| Wait for `session_left` in a local test | Watch `session_disconnected` | Local Play ends Sessions only when the World ends |
| Skip the import pass after adding scripts | `<summer> --headless --path . --import` first | New classes are unknown until imported |

## Next

`multiplayer-publish`: export the summer.games bundle and upload it as a Build.
