# summer_add_node

Add a new node to the scene tree.

Pass the exact res:// scenePath to mutate. The scene does not need to be the
active editor tab.

Common node types:
- 3D: Node3D, MeshInstance3D, CharacterBody3D, RigidBody3D, StaticBody3D, Camera3D, DirectionalLight3D, OmniLight3D, SpotLight3D, WorldEnvironment, CollisionShape3D, Area3D
- 2D: Node2D, Sprite2D, CharacterBody2D, RigidBody2D, StaticBody2D, Camera2D, CollisionShape2D, Area2D, TileMapLayer
- UI: Control, Label, Button, TextEdit, Panel, VBoxContainer, HBoxContainer, MarginContainer
- Audio: AudioStreamPlayer, AudioStreamPlayer3D

The parent path uses "./" prefix for relative paths from scene root. E.g., "./World" means the "World" child of the root node.
