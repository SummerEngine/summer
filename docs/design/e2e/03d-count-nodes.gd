func _run():
	var packed = load("res://scenes/rooms/room_01.tscn")
	var root = packed.instantiate()
	var total = 0
	var depth_le_2 = 0
	var stack = [[root, 0]]
	while stack.size() > 0:
		var item = stack.pop_back()
		var n = item[0]
		var d = item[1]
		total += 1
		if d <= 2:
			depth_le_2 += 1
		for c in n.get_children():
			stack.append([c, d + 1])
	print("E2E_COUNT total_nodes=", total, " depth_le_2=", depth_le_2, " root=", root.name)
	root.free()
