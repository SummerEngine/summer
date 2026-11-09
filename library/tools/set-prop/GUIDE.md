# summer_set_prop

Set a property on a node. This is the primary way to configure nodes after adding them.

VALUE FORMAT — Godot string syntax for complex types:
- Vector3: "Vector3(0, 10, 0)" — position, scale, rotation_degrees
- Vector2: "Vector2(100, 200)" — 2D position, size
- Color: "Color(1, 0.5, 0, 1)" — RGBA, always 4 components, values 0.0-1.0
- Transform3D: "Transform3D(1,0,0, 0,1,0, 0,0,1, 0,5,0)" — basis + origin
- Resource class name: "BoxMesh", "SphereMesh", "StandardMaterial3D" — auto-instantiated
- Numbers: 1.5, 42 — native JSON
- Booleans: true, false — native JSON
- Strings: "hello" — native JSON

COMMON PROPERTIES:
- position: "Vector3(x, y, z)" — world position
- rotation_degrees: "Vector3(rx, ry, rz)" — rotation in degrees
- scale: "Vector3(sx, sy, sz)" — scale factor
- visible: true/false — visibility
- mesh: "BoxMesh", "SphereMesh", "CapsuleMesh", "CylinderMesh", "PlaneMesh"
- shadow_enabled: true — for lights
- light_energy: 1.5 — light intensity
- fov: 75.0 — camera field of view
