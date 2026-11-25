@tool
extends Node

# The toolkit installs this fixed script in a private OS-temporary wrapper scene.
# Read registration and existing compiled metadata. Loading a script here could run _static_init.
func _required_arguments(row: Dictionary, native_base: String) -> int:
	if row.get("language") != "GDScript":
		return -1
	var current := ResourceLoader.get_cached_ref(row["path"]) as GDScript
	if not current or current.get_global_name() != row["class"] or current.get_instance_base_type() != native_base:
		return -1
	var required := 0
	var found := false
	while current:
		# A file can change before the editor reloads the compiled version.
		if not current.resource_path.begins_with("res://") or not FileAccess.file_exists(current.resource_path) or current.source_code != FileAccess.get_file_as_string(current.resource_path):
			return -1
		if not found and current.has_script_method("_init"):
			for method in current.get_script_method_list():
				if method.name == &"_init":
					required = method.args.size() - method.default_args.size()
					found = true
					break
			if not found:
				return -1
		current = current.get_base_script() as GDScript
	return required

func _ready() -> void:
	var wrapper := String(get_script().resource_path).get_slice("::", 0)
	if wrapper.get_file() != "wrapper.tscn":
		return
	var dir := wrapper.get_base_dir()
	var cfg: Variant = JSON.parse_string(FileAccess.get_file_as_string(dir.path_join("config.json")))
	if not cfg is Dictionary or not cfg.get("class_name") is String or not cfg.get("request_id") is String:
		return
	var name_requested: String = cfg.class_name
	var info := {"class_name": name_requested, "kind": "unknown", "exists": false, "native_class": false, "can_instantiate": false, "is_node": false}
	if ClassDB.class_exists(name_requested):
		info.merge({"kind": "native", "exists": true, "native_class": true, "can_instantiate": ClassDB.can_instantiate(name_requested), "is_node": ClassDB.is_parent_class(name_requested, "Node")}, true)
	else:
		var scripts := {}
		for row in ProjectSettings.get_global_class_list():
			scripts[String(row["class"])] = row
		if scripts.has(name_requested):
			var script: Dictionary = scripts[name_requested]
			var base := String(script["base"])
			var seen := {}
			while scripts.has(base) and not seen.has(base):
				seen[base] = true
				base = String(scripts[base]["base"])
			info.merge({"kind": "script", "exists": true, "script_path": String(script["path"]), "abstract": script["is_abstract"], "native_base": base}, true)
			if ClassDB.class_exists(base):
				info["is_node"] = ClassDB.is_parent_class(base, "Node")
				info["base_can_instantiate"] = ClassDB.can_instantiate(base)
				if info["is_node"] and not script["is_abstract"]:
					info["required_arguments"] = _required_arguments(script, base)
	var result := FileAccess.open(dir.path_join("result.json"), FileAccess.WRITE)
	if result:
		result.store_string(JSON.stringify({"request_id": cfg.request_id, "info": info}))
