# summer-multiplayer: complete code

A trimmed version of the network layer from a working co-op garden game, verified on Summer 0.6.0 with a
dedicated authority and two Local Play clients. Replace the documents and actions with your game's own.

## net.gd (shared by client and authority)

```gdscript
class_name GameNet
extends RefCounted

const GAME_ID := "game.my-game"
const QUEUE := &"main"
const WORLD := &"g.world"   # public document
const ME := &"g.me"         # private document, one group per Session
const POSE := &"g.pose"     # owner-written movement
const CMD := &"g.cmd"       # every action
const MAX_PLAYERS := 8


static func _schema(id: StringName, members: Dictionary) -> SummerNetworkSchema:
	var schema := SummerNetworkSchema.new()
	schema.schema_id = id
	var fields: Array[SummerNetworkField] = []
	for key: String in members:
		var f := SummerNetworkField.new()
		f.field_name = StringName(key)
		f.type = members[key]
		fields.append(f)
	schema.state_fields = fields
	return schema


static func _stream(id: StringName, fields: Dictionary, owner: bool, private: bool, keys: int, bytes: int) -> SummerNetworkStateStream:
	var s := SummerNetworkStateStream.new()
	s.stream_id = id
	s.state_schema = _schema(StringName(String(id) + ".v1"), fields)
	s.writer_policy = SummerNetworkStateStream.WRITER_OWNER if owner else SummerNetworkStateStream.WRITER_AUTHORITY
	s.audience_policy = SummerTargetSessionAudience.new() if private else SummerWorldAudience.new()
	s.audience_policy.max_expansion = 1 if private else MAX_PLAYERS   # 0 (the default) means nobody
	s.max_audience_count = 1 if private else MAX_PLAYERS
	s.max_keys = keys
	s.max_state_bytes = bytes
	s.max_total_bytes = bytes * keys
	return s


static func build(parent: Node) -> Dictionary:
	var world := SummerNetworkWorld.new()
	world.name = "NetworkWorld"
	parent.add_child(world)
	var entities := Node.new()
	entities.name = "Entities"
	parent.add_child(entities)
	var c := SummerNetworkComposition.new()
	c.network_version = "1.0.0"
	var B := SummerNetworkField.TYPE_PACKED_BYTE_ARRAY   # documents: a String would cap at 256 bytes
	var streams: Array[SummerNetworkStateStream] = []
	streams.append(_stream(WORLD, {"b": B}, false, false, 1, 60000))
	streams.append(_stream(ME, {"b": B}, false, true, MAX_PLAYERS, 60000))
	streams.append(_stream(POSE, {"pid": SummerNetworkField.TYPE_STRING, "p": SummerNetworkField.TYPE_VECTOR3, "yaw": SummerNetworkField.TYPE_FLOAT}, true, false, MAX_PLAYERS, 256))
	c.state_streams = streams
	var cmd := SummerNetworkOccurrenceStream.new()
	cmd.stream_id = CMD
	cmd.command_scope = SummerNetworkOccurrenceStream.COMMAND_SCOPE_WORLD
	cmd.command_timeout_msec = 8000
	cmd.payload_schema = _schema(&"g.cmd.v1", {"b": B})
	cmd.result_schema = _schema(&"g.cmd.result.v1", {"b": B})   # without it, handle.result is empty
	c.occurrence_streams = [cmd]
	var spawner := SummerNetworkSpawner.new()
	spawner.name = "Spawner"
	spawner.network_world_path = NodePath("../NetworkWorld")
	spawner.entities_root_path = NodePath("../Entities")
	spawner.player_archetype = &""
	spawner.network_composition = c
	parent.add_child(spawner)
	return {"world": world, "spawner": spawner}


static func pack(d: Dictionary) -> Dictionary:
	return {"b": JSON.stringify(d).to_utf8_buffer()}


static func unpack(fields: Dictionary) -> Dictionary:
	var parsed: Variant = JSON.parse_string((fields.get("b", PackedByteArray()) as PackedByteArray).get_string_from_utf8())
	return parsed if parsed is Dictionary else {}
```

## authority.gd (the headless_engine component's entry scene)

```gdscript
extends Node

var spawner: SummerNetworkSpawner
var net_world: SummerNetworkWorld
var world_group: SummerNetworkStateGroup
var me_groups := {}      # user_id -> private group
var profiles := {}       # user_id -> {"state": "loading" | "ready" | "failed", "data": {}}
var receipts := {}       # user_id -> {request_id: result}   (keep the last ~64)
var state := {"players": {}}


func _ready() -> void:
	var built := GameNet.build(self)
	net_world = built["world"]
	spawner = built["spawner"]
	spawner.command_received.connect(_on_command)
	net_world.session_joined.connect(_on_joined)
	net_world.session_left.connect(_on_left)
	var init: SummerResult = await Summer.initialize(GameNet.GAME_ID).get_result_or_completed_signal()
	if not init.ok:
		push_error(init.message)
		return
	if not net_world.is_ready():
		await net_world.binding_ready
	if not spawner.is_network_ready():
		await spawner.network_ready
	world_group = spawner.create_state_group(GameNet.WORLD, &"world", GameNet.pack(state))


func _on_joined(s: SummerSession) -> void:
	var uid := s.player.user_id
	profiles[uid] = {"state": "loading", "data": {}}
	var op := Summer.authority.player_data.load(s)
	var r: SummerResult = await op.get_result_or_completed_signal()
	if r == null or not r.ok:
		profiles[uid] = {"state": "failed", "data": {}}   # unknown is not empty
		return
	var rec: SummerPlayerDataRecord = op.secret_record
	profiles[uid] = {"state": "ready", "data": rec.data if rec.exists else {}}


func _on_command(req: SummerNetworkCommandRequest) -> void:
	var s := req.get_session()
	var uid := s.player.user_id                       # verified identity, never from the payload
	var cmd := GameNet.unpack(req.get_payload())
	var rid := str(cmd.get("rid", ""))
	if receipts.get(uid, {}).has(rid):
		req.accept({}, GameNet.pack(receipts[uid][rid]))   # duplicate: same answer, no second effect
		return
	if cmd.get("c", "") == "join":
		var p: Dictionary = profiles.get(uid, {"state": "loading"})
		if p["state"] != "ready":
			req.refuse(&"loading" if p["state"] == "loading" else &"profile_unavailable")
			return
		state["players"][uid] = {"name": s.player.display_name, "coins": int(p["data"].get("coins", 20))}
		me_groups[uid] = spawner.create_state_group(GameNet.ME, StringName("me_" + uid.sha256_text().left(16)), GameNet.pack(state["players"][uid]), null, null, s)
		var pose := spawner.create_state_group(GameNet.POSE, StringName("pose_" + uid.sha256_text().left(16)), {"pid": uid, "p": Vector3.ZERO, "yaw": 0.0}, s)
		pose.set_acceptance_policy(func(next: Dictionary, cur: Dictionary) -> bool:
			return next["pid"] == uid and (next["p"] as Vector3).distance_to(cur["p"]) < 12.0)
	# ... validate and apply other actions here; refuse with a stable reason on failure ...
	var result := {"ok": true, "rid": rid}
	receipts[uid] = receipts.get(uid, {})
	receipts[uid][rid] = result
	world_group.reset(GameNet.pack({"players": state["players"].keys()}))
	(me_groups[uid] as SummerNetworkStateGroup).reset(GameNet.pack(state["players"][uid]))
	req.accept({}, GameNet.pack(result))


func _on_left(s: SummerSession, _reason: String) -> void:
	var uid := s.player.user_id
	if state["players"].has(uid):
		# Commits stay available until the World stops; reuse the same save_id on a retryable failure.
		var save_id := "%s-%d" % [uid.sha256_text().left(12), Time.get_unix_time_from_system()]
		for attempt in 3:
			var r: SummerResult = await Summer.authority.player_data.commit_secret(s, save_id, state["players"][uid]).get_result_or_completed_signal()
			if r.ok or r.message.contains("superseded"):
				break
			await get_tree().create_timer(1.0 + attempt * 2.0).timeout
		state["players"].erase(uid)
```

## client.gd (part of the client entry scene)

```gdscript
extends Node

var spawner: SummerNetworkSpawner
var me := {}


func _ready() -> void:
	spawner = GameNet.build(self)["spawner"]
	spawner.state_group_created.connect(_on_group)        # before joining
	var init: SummerResult = await Summer.initialize(GameNet.GAME_ID).get_result_or_completed_signal()
	if not init.ok:
		return   # offline fallback here
	var join := Summer.client.join(SummerJoinTarget.queue(GameNet.QUEUE))
	join.acceptance_required.connect(func(p: SummerMatchmakingProposal) -> void: p.accept())
	var joined: SummerResult = await join.get_result_or_completed_signal()   # bound this wait in a real game
	if not joined.ok:
		return
	if not spawner.is_network_ready():
		await spawner.network_ready
	var rid := "join-%d" % Time.get_ticks_msec()
	while true:   # the authority answers "loading" until our save is read
		var r := await command({"c": "join", "rid": rid})
		if r["ok"] or r["error"] != "loading":
			break
		await get_tree().create_timer(0.6).timeout


func command(cmd: Dictionary) -> Dictionary:
	var admission := spawner.enqueue_command(GameNet.CMD, GameNet.pack(cmd))
	if not admission.is_enqueued():
		return {"ok": false, "error": "not_admitted"}      # keep it; resend later with the same rid
	var h := admission.get_handle()
	if not h.is_terminal():
		await h.completed
	if h.get_outcome() == SummerNetworkCommandHandle.OUTCOME_ACCEPTED:
		return {"ok": true, "error": "", "result": GameNet.unpack(h.get_result())}
	return {"ok": false, "error": String(h.get_reason())}


func _on_group(g: SummerNetworkStateGroup) -> void:
	g.state_installed.connect(func(st: Dictionary, _rev: int, _reset: bool) -> void:
		if g.get_stream_id() == GameNet.ME:
			me = GameNet.unpack(st))
```

## world.json / summer.build.json

```json
{"schema": "summer.world-definition.v1", "definition_id": "main-world", "lifetime": "match_scoped",
 "topology": "dedicated", "client_entry_point": "res://main.tscn",
 "components": [{"component_id": "game", "profile": "headless_engine", "entry_point": "net/authority.tscn", "owns": ["match"]}]}
```

```json
{"schema": "summer.build.v2", "runtime": {"worldDefinitions": ["world.json"],
 "queues": [{"name": "main", "worldDefinition": "main-world", "minPlayers": 1, "maxPlayers": 8}]}}
```
