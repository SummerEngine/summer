# summer_frame_nodes

Frame one or more nodes with a camera fitted to their WORLD bounds and render it with the scene's REAL WorldEnvironment, lights, fog and tonemap (unlike summer_screenshot nodePath, which only works with the flat preview environment).

Pick the side with direction (front/back/left/right/top/iso) or an explicit from vector; fill sets how much of the frame they span. bookmark_name also saves the fitted pose so every later render (summer_shot_sheet, summer_debug_views, summer_screenshot framing:"bookmark") lines up with it. marks:true adds numbered labels mapped to node paths.

An explicit from is checked in-engine before you trust the image: if walls block the nodes, or the camera stands behind or inside a one-sided surface (its back is not drawn, so the image would look THROUGH the wall), the caption opens with a WARNING and the nearest valid from (+ fov) to pass back. With marks:true every labelled node gets an occlusion test (centre + 4 bounds points); hidden ones are noted "(hidden behind <path>)".

Returns the image + caption: the pose as Vector3 literals, the bounds, the environment used, the view check, and the mark list. Read-only: the scene file, the open tab and the undo history are never touched (the render is an offscreen copy of the SAVED scene). The image arrives inline; the caption carries poses, labels and numbers. Failures are structured (failure_reason), never a silent fallback.
