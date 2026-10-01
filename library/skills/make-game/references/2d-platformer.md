# 2D Platformer - Core

Side-scrolling platformer blueprint: architecture, the level, and the core loop.
Movement itself lives in the `character-movement` skill (base controller) and its
`references/platformer-feel.md` (coyote time, jump buffer, variable height) - do
not rewrite it here; wire it in. For Celeste-grade precision movement (dash, wall
jump, climb) use `celeste-momentum-platforming` instead.

## Minimum playable base (build this first)

Scene first (the make-game Scaffold phase): `main.tscn` with a Node2D root, a ground `StaticBody2D`
with a `CollisionShape2D`, the player, and a `Camera2D` child of the player. Prove
run + jump + land before anything else. Placeholder art is a colored
`ColorRect`/`Sprite2D`.

## Architecture (grows into a full game)

```
res://
  scenes/
    player/player.tscn
    rooms/room_01.tscn        # one .tscn per room/level
    enemies/patrol_enemy.tscn
    ui/{hud,pause_menu,main_menu,game_over}.tscn
  scripts/
    autoloads/
      event_bus.gd            # global signals, decouples systems
      game_manager.gd         # score, lives, current room, checkpoint
      audio_manager.gd        # pooled SFX + music
      save_manager.gd
    player/player_controller.gd
    systems/{coin,checkpoint,killzone,moving_platform,one_way_platform,
             crumbling_platform,bounce_pad,door,level_end}.gd
```

Add autoloads only once the base loop works. Register in Project Settings in
dependency order: EventBus first (others reference it), then GameManager, then the
rest. All autoloads `process_mode = ALWAYS` so they survive pause.

## Collision layers (set names in Project Settings)

| Layer | Name | Used by |
|-------|------|---------|
| 1 | World | TileMap, static platforms |
| 2 | Player | Player body |
| 3 | Enemies | Enemy bodies |
| 4 | PlayerHitbox | Sword/stomp hit area |
| 5 | EnemyHitbox | Enemy hit area |
| 6 | PlayerHurtbox | Player hurt area |
| 7 | EnemyHurtbox | Enemy hurt area |
| 8 | Collectibles | Coins, gems |
| 9 | Triggers | Doors, killzones, checkpoints |

Hitboxes mask the OPPOSING hurtbox (see the `combat-basics` skill). The stomp detector is a
separate Area under the player masking only the Enemies layer.

## Building the level with a TileMap

Use a `TileMapLayer` (Godot 4.3+) for the solid world. Create a `TileSet`, paint
the collision polygon on the solid tiles, put the layer on the World collision
layer. The player collides with it for free - no per-tile StaticBody.

- One `TileMapLayer` for collidable terrain, a second (no collision, lower
  z-index) for background decoration.
- For large levels, split into room `.tscn`s and load the current room via a
  RoomManager; connect doors to `change_scene_to_file` or swap room instances.
- Parallax background: `Parallax2D` (or ParallaxBackground) layers with
  `motion_scale` < 1 so distant layers move slower.

## Moving, one-way, and crumbling platforms

These three cover most platformer level tech.

```gdscript
# moving_platform.gd - AnimatableBody2D so riders move with it
extends AnimatableBody2D
@export var offset: Vector2 = Vector2(200, 0)
@export var duration: float = 2.0
func _ready() -> void:
	var t := create_tween().set_loops().set_trans(Tween.TRANS_SINE)
	t.tween_property(self, "position", position + offset, duration)
	t.tween_property(self, "position", position, duration)
```

Use `AnimatableBody2D` (not StaticBody2D) for movers - it carries the player. For
one-way platforms, enable `one_way_collision` on the platform's CollisionShape2D
so the player jumps up through and lands on top. Crumbling platform: on
`body_entered`, start a short timer, shake, then disable collision and fade out;
re-enable after a respawn delay.

## Checkpoints and death

```gdscript
# checkpoint.gd
extends Area2D
func _ready() -> void:
	body_entered.connect(func(b):
		if b.is_in_group("player"):
			GameManager.checkpoint = global_position)

# killzone.gd - fall/spike death
extends Area2D
func _ready() -> void:
	body_entered.connect(func(b):
		if b.is_in_group("player"):
			b.die())   # player respawns at GameManager.checkpoint
```

## Core loop checklist (the 30-second bar)

- Run + jump feels good (tuned gravity/fall multiplier, coyote + buffer).
- Coins/goal give immediate feedback: sound + pop tween + counter tick.
- Death is instant and respawns at the last checkpoint, no long reload.
- A visible goal (flag/door) ends the level with a clear result.

Enemies, hazards, juice, and metroidvania progression are in
`2d-platformer-polish.md`.
