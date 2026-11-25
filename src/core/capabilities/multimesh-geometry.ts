/** Godot's drawn instance range and frame for asset and placement measurements. */
export const MULTIMESH_GEOMETRY_GDSCRIPT = String.raw`
func _drawn_instances(node):
	if not (node is MultiMeshInstance3D):
		return 1
	var mm = node.multimesh
	return mm.instance_count if mm.visible_instance_count < 0 else mini(mm.instance_count, mm.visible_instance_count)


func _drawn_instance_transform(node, frame, index):
	return frame * node.multimesh.get_instance_transform(index) if node is MultiMeshInstance3D else frame


func _can_read_multimesh_transforms():
	return DisplayServer.get_name() != "headless" and RenderingServer.get_current_rendering_driver_name() != "dummy"
`;
