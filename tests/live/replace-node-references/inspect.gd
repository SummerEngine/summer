extends SceneTree
func vec(v:Vector3)->Array:
	return [v.x,v.y,v.z]
func tx(t:Transform3D)->Dictionary:
	return {"origin":vec(t.origin),"basis":[vec(t.basis.x),vec(t.basis.y),vec(t.basis.z)]}
func ref_path(v,root:Node):
	if v == null: return null
	if not is_instance_valid(v): return "FREED"
	if v is Node:
		if v == root or root.is_ancestor_of(v): return str(root.get_path_to(v))
		return "OUTSIDE"
	return str(v)
func walk(node:Node,root:Node,rows:Array):
	var row={"path":str(root.get_path_to(node)),"type":node.get_class(),"scene":node.scene_file_path,"owner":ref_path(node.owner,root),"children":[]}
	for child in node.get_children():row.children.append(str(child.name))
	if node is Node3D:
		row.local=tx(node.transform)
		row.global=tx(node.global_transform)
	if node.name == "Pulse":
		row.connections=[]
		for connection in node.get_signal_connection_list("timeout"):
			var cb=connection.callable
			row.connections.append({"method":str(cb.get_method()),"target":ref_path(cb.get_object(),root),"bound":cb.get_bound_arguments(),"flags":connection.flags})
	if node.has_meta("pulse"): row.pulse=node.get_meta("pulse")
	if node.get_script()!=null:
		row.script=node.get_script().resource_path
		row.refs={}
		for prop in node.get_property_list():
			if prop.name in ["target","child_ref","parent_ref","node_path","first","reject","later"]:
				row.refs[prop.name]=str(node.get(prop.name)) if prop.name=="node_path" else ref_path(node.get(prop.name),root)
	rows.append(row)
	for child in node.get_children():walk(child,root,rows)
func _initialize():
	call_deferred("inspect_all")
func inspect_all():
	var manifest=JSON.parse_string(FileAccess.get_file_as_string("res://audit-manifest.json"))
	var result={}
	for item in manifest:
		var packed=ResourceLoader.load(item.file,"PackedScene",ResourceLoader.CACHE_MODE_IGNORE)
		if packed==null:
			result[item.tag]={"error":"load failed"}
			continue
		var instance=packed.instantiate()
		root.add_child(instance)
		if instance.has_node("Pulse"): instance.get_node("Pulse").emit_signal("timeout")
		var rows=[]
		walk(instance,instance,rows)
		result[item.tag]={"source":item.source,"file":item.file,"rows":rows}
		instance.free()
	var output=FileAccess.open("res://fresh-graphs.json",FileAccess.WRITE)
	output.store_string(JSON.stringify(result,"\t",false,true))
	print("AUDIT_FRESH_GRAPHS "+str(result.size()))
	quit()
