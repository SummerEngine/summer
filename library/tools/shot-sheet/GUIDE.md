# summer_shot_sheet

Render several bookmarks and/or explicit poses into ONE labelled grid image in a single call: same tile size, same view, real lighting. Use it after every change to see all hero views at once instead of N screenshots.

compare_previous:true turns each bookmark into a row of [previous | now | difference map] and reports the share of pixels that changed and where. Each bookmark keeps exactly one previous render (its compare baseline) at res://.summer/shots/<bookmark>.jpg (JPEG, <= 1024 px; the folder is capped at 20 MB, oldest first). Only compare_previous:true or update_previous:true replaces it; a plain sheet creates a missing baseline and never overwrites one. view renders every tile as lighting/unshaded/normals/overdraw/wireframe instead of beauty.

Returns the grid + caption (tile number -> label and pose, difference stats). Read-only: the scene file, the open tab and the undo history are never touched (the render is an offscreen copy of the SAVED scene). The image arrives inline; the caption carries poses, labels and numbers. Failures are structured (failure_reason), never a silent fallback.
