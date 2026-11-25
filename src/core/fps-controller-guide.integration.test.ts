import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const editor = process.env.SUMMER_EDITOR_BIN;

it.runIf(Boolean(editor))("moves along the camera axes with and without a rotated player parent", () => {
  const guide = readFileSync(new URL("../../library/skills/fps-controller/SKILL.md", import.meta.url), "utf8");
  const controller = guide.match(/^```gdscript\n(class_name PlayerController\n[\s\S]*?)^```/m)?.[1];
  expect(controller).toBeDefined();

  const project = mkdtempSync(join(tmpdir(), "fps-guide-movement-"));
  try {
    writeFileSync(join(project, "project.godot"), 'config_version=5\n[application]\nconfig/name="FPS guide movement"\n');
    writeFileSync(join(project, "controller.gd"), controller!);
    writeFileSync(join(project, "probe.gd"), `extends SceneTree

func _initialize():
	call_deferred("check_movement")

func check_movement():
	for action in ["move_left", "move_right", "move_forward", "move_back", "jump", "sprint"]:
		InputMap.add_action(action)
	var floor_body = StaticBody3D.new()
	var floor_collision = CollisionShape3D.new()
	var floor_box = BoxShape3D.new()
	floor_box.size = Vector3(50, 1, 50)
	floor_collision.shape = floor_box
	floor_collision.position.y = -0.5
	floor_body.add_child(floor_collision)
	root.add_child(floor_body)
	var rows = []
	for room_yaw in [0.0, 90.0]:
		for action in ["move_forward", "move_right"]:
			var room = Node3D.new()
			room.rotation.y = deg_to_rad(room_yaw)
			root.add_child(room)
			var player = preload("res://controller.gd").new()
			player.rotation.y = deg_to_rad(20)
			var collision = CollisionShape3D.new()
			var capsule = CapsuleShape3D.new()
			collision.shape = capsule
			collision.position.y = capsule.height / 2
			player.add_child(collision)
			var head = Node3D.new()
			head.name = "Head"
			head.rotation.x = deg_to_rad(25)
			var camera = Camera3D.new()
			camera.name = "Camera"
			head.add_child(camera)
			player.add_child(head)
			room.add_child(player)
			camera.current = true
			for tick in 4:
				await physics_frame
			var frame = camera.get_camera_transform().basis
			var expected = -frame.z if action == "move_forward" else frame.x
			expected.y = 0
			var start = player.global_position
			Input.action_press(action)
			for tick in 20:
				await physics_frame
			Input.action_release(action)
			var travel = player.global_position - start
			var rise = travel.y
			travel.y = 0
			rows.append({"yaw": room_yaw, "action": action, "distance": travel.length(), "rise": rise, "on_floor": player.is_on_floor(),
					"alignment": travel.normalized().dot(expected.normalized())})
			room.free()
	FileAccess.open("res://measurements.json", FileAccess.WRITE).store_string(JSON.stringify(rows))
	quit()
`);
    execFileSync(editor!, ["--headless", "--fixed-fps", "60", "--path", project, "--summer-no-api", "--summer-no-publish", "--script", "res://probe.gd"], {
      env: { HOME: project, PATH: process.env.PATH, SUMMER_NO_TELEMETRY: "1" },
      timeout: 15000,
    });
    const rows: { yaw: number; action: string; distance: number; alignment: number; rise: number; on_floor: boolean }[] =
      JSON.parse(readFileSync(join(project, "measurements.json"), "utf8"));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.distance, JSON.stringify(row)).toBeGreaterThan(0.5);
      expect(row.on_floor, JSON.stringify(row)).toBe(true);
      expect(Math.abs(row.rise), JSON.stringify(row)).toBeLessThan(0.002);
      expect(row.alignment, JSON.stringify(row)).toBeGreaterThan(0.999);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
