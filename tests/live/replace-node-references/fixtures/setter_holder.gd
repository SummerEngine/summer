@tool
extends Node
var assignments = {}
@export var first: Node3D:
	set(value):
		assignments["first"] = assignments.get("first", 0) + 1
		first = value
@export var reject: Node3D:
	set(value):
		assignments["reject"] = assignments.get("reject", 0) + 1
		if value != null and str(value.name).contains("SummerReplace"):
			return
		reject = value
@export var later: Node3D:
	set(value):
		assignments["later"] = assignments.get("later", 0) + 1
		later = value
