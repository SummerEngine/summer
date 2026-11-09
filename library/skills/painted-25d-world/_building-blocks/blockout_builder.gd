extends Node3D
## Builds a location's blockout from a JSON spec, so the same file drives the engine and the engine-free
## wireframe preview over the concept (preview.py). Put this node as the location's `Painted` child.
## Spec: {"objects": [{"name", "kind", "color", "solid", ...}]}, metres, y up:
##   box    pos (centre), size [x, y, z], yaw / rot_x / rot_z (degrees), scale
##   prism  pos, size (a PrismMesh: the ridge along z), yaw / rot_x / rot_z
##   cyl    pos (base centre), r_bot, r_top, height
##   sphere pos (centre), radius, sy (vertical squash)
##   poly   points [[x, z], ...], top, depth: flat ground or a quay, extruded down, two-sided collision
##   wall   segments [[[x, z], [x, z]], ...], height: invisible blockers along water and ledges (leave gaps at
##          pier roots and doorways)
## Each solid object gets a StaticBody3D with a matching shape; every mesh gets one flat colour from COLORS that
## tells the painter what it is (the paint-over prompt repeats them as a colour key). Name door and step slabs
## "..._door" / "..._steps": painted_location.gd hides them in the game. A gable roof is two parts: a
## wall-coloured prism for the gable plus two thin slanted roof slabs with overhang; a single roof-coloured prism
## makes the painter paint roof on the gable wall.

@export_file("*.json") var spec := "res://painted/blockout.json"

## Colour key: red tile roof, yellow thatch, dark blue slate, cream plaster, grey stone, brown wood and doors,
## green grass and leaves, pink flower beds, orange lamps and fruit, light brown cobbles and dirt, blue water.
const COLORS := {
	"tile": Color(0.78, 0.25, 0.18), "thatch": Color(0.88, 0.72, 0.32), "slate": Color(0.22, 0.26, 0.42),
	"plaster": Color(0.93, 0.88, 0.76), "stone": Color(0.55, 0.55, 0.55), "rock": Color(0.42, 0.4, 0.44),
	"wood": Color(0.5, 0.33, 0.18), "door": Color(0.42, 0.26, 0.14), "crate": Color(0.66, 0.48, 0.28),
	"grass": Color(0.36, 0.62, 0.25), "leaf": Color(0.2, 0.55, 0.2), "bush": Color(0.3, 0.55, 0.22),
	"bark": Color(0.35, 0.22, 0.12), "flower": Color(0.95, 0.55, 0.75), "lamp": Color(1.0, 0.65, 0.2),
	"cobble": Color(0.72, 0.6, 0.45), "dirt": Color(0.72, 0.56, 0.38), "water": Color(0.1, 0.35, 0.5),
	"canvas": Color(0.9, 0.3, 0.3), "iron": Color(0.15, 0.15, 0.17), "glass": Color(0.35, 0.5, 0.75),
	"floor": Color(0.6, 0.42, 0.25), "rug": Color(0.6, 0.15, 0.2), "fire": Color(1.0, 0.5, 0.1),
	"white": Color(0.97, 0.97, 0.97),
}

func _ready() -> void:
	var data: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(spec))
	for o in data.objects:
		if o.kind == "wall":
			_walls(o)
		else:
			_build(o)

## Invisible collision only: keeps the player out of the water and on the piers.
func _walls(o: Dictionary) -> void:
	var body := StaticBody3D.new()
	body.name = o.name
	for seg in o.segments:
		var a := Vector3(seg[0][0], 0, seg[0][1])
		var b := Vector3(seg[1][0], 0, seg[1][1])
		var cs := CollisionShape3D.new()
		var s := BoxShape3D.new()
		s.size = Vector3(a.distance_to(b) + 0.1, o.height, 0.2)
		cs.shape = s
		cs.position = (a + b) / 2.0 + Vector3(0, o.height / 2.0, 0)
		cs.rotation.y = atan2(-(b.z - a.z), b.x - a.x)
		body.add_child(cs)
	add_child(body)

func _build(o: Dictionary) -> void:
	var mesh: Mesh
	var shape: Shape3D
	var offset := Vector3.ZERO
	match o.kind:
		"box":
			var b := BoxMesh.new()
			b.size = _v(o.size)
			mesh = b
			var s := BoxShape3D.new()
			s.size = b.size
			shape = s
		"prism":
			var p := PrismMesh.new()
			p.size = _v(o.size)
			mesh = p
			shape = p.create_convex_shape()
		"cyl":
			var c := CylinderMesh.new()
			c.top_radius = o.r_top
			c.bottom_radius = o.r_bot
			c.height = o.height
			c.radial_segments = 24
			mesh = c
			offset.y = o.height / 2.0
			var s := CylinderShape3D.new()
			s.radius = maxf(o.r_top, o.r_bot)
			s.height = o.height
			shape = s
		"sphere":
			var sp := SphereMesh.new()
			sp.radius = o.radius
			sp.height = o.radius * 2.0
			mesh = sp
			var s := SphereShape3D.new()
			s.radius = o.radius
			shape = s
		"poly":
			mesh = _extrude(o.points, o.top, o.depth)
			shape = mesh.create_trimesh_shape()
			(shape as ConcavePolygonShape3D).backface_collision = true
	var mi := MeshInstance3D.new()
	mi.name = o.name
	mi.mesh = mesh
	var mat := StandardMaterial3D.new()
	mat.albedo_color = COLORS.get(o.color, Color.MAGENTA)
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	mi.material_override = mat
	var holder: Node3D = mi
	if o.get("solid", false):
		var body := StaticBody3D.new()
		body.name = o.name + "Body"
		var cs := CollisionShape3D.new()
		cs.shape = shape
		body.add_child(cs)
		body.add_child(mi)
		holder = body
	if o.kind != "poly":
		holder.position = _v(o.pos) + offset
		holder.rotation_degrees = Vector3(o.get("rot_x", 0.0), o.get("yaw", 0.0), o.get("rot_z", 0.0))
		if o.kind == "sphere" and o.has("sy"):
			mi.scale = Vector3(1, o.sy, 1)
		if o.has("scale"):
			holder.scale = _v(o.scale)
	add_child(holder)

## A flat polygon (x, z points) extruded from top down by depth, with side walls.
func _extrude(points: Array, top: float, depth: float) -> ArrayMesh:
	var pts := PackedVector2Array()
	for p in points:
		pts.append(Vector2(p[0], p[1]))
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var tri := Geometry2D.triangulate_polygon(pts)
	for i in range(0, tri.size(), 3):
		for k in [0, 2, 1]:
			var p := pts[tri[i + k]]
			st.add_vertex(Vector3(p.x, top, p.y))
	for i in pts.size():
		var a := pts[i]
		var b := pts[(i + 1) % pts.size()]
		var a0 := Vector3(a.x, top, a.y)
		var b0 := Vector3(b.x, top, b.y)
		var a1 := a0 - Vector3(0, depth, 0)
		var b1 := b0 - Vector3(0, depth, 0)
		for v in [a0, b0, b1, a0, b1, a1]:
			st.add_vertex(v)
	st.generate_normals()
	return st.commit()

func _v(a: Array) -> Vector3:
	return Vector3(a[0], a[1], a[2])
