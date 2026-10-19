extends Area3D
## A door between painted locations. When the player walks in, the world moves them into `to` at `spawn`.
## Put `spawn` (a Marker3D) inside the target room or outside the target door, clear of that room's own door
## trigger, or the player bounces straight back.

@export var to: NodePath
@export var spawn: NodePath

func _ready() -> void:
	body_entered.connect(_on_body_entered)

func _on_body_entered(body: Node) -> void:
	var world := get_parent()
	while world != null and not world.has_method("go"):
		world = world.get_parent()
	if world != null and body == world.player:
		world.go(get_node(to), (get_node(spawn) as Node3D).global_position)
