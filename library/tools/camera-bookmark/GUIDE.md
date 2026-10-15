# summer_camera_bookmark

Save, list, or delete named camera viewpoints for the edited 3D scene. A bookmark is a fixed pose (position, look_at, fov) stored IN THE PROJECT at res://.summer/camera_bookmarks.json, so it survives sessions and machines — the scene file is never touched.

WHY: screenshots taken from a preset framing re-fit the scene bounds every time, so a before/after pair shifts whenever anything moves; a bookmark is the same pose every time, which makes before/after comparison real. Save once, then reuse on every capture: summer_screenshot target:"scene" framing:"bookmark" bookmark_name:"<name>" (add marks:true for numbered labels mapped to node paths).

action:
  "save"   — name (1-64 of A-Z a-z 0-9 _ -) plus EITHER position + look_at as Godot literals ("Vector3(x, y, z)", optional fov, default 60) OR neither: omit both to capture the CURRENT editor 3D viewport camera (result pose_source: "editor_viewport" vs "explicit"; overwritten says whether a same-named bookmark was replaced).
  "list"   — every saved bookmark (names sorted, poses, created timestamps, file path).
  "delete" — remove one by name (result lists the remaining names).

Failures are structured: bad_args (name grammar, half-given pose, fov outside 1..179, position == look_at), no_editor_camera (no pose given and no 3D viewport camera to capture), not_found (+ available names), io_failed (file unreadable/unwritable; a malformed file is reported, never overwritten). Edit-time only — no running game needed. If this engine build predates the bookmark ops, the result is a structured engine_lacks_op failure (nothing is sent) naming the fallback.
