# summer_debug_views

One pose rendered as a grid of debug views next to the beauty pass: beauty, lighting (light only: direction, pools, dead-dark areas), unshaded (albedo: texture quality, value grouping), normals (world-space, x red y green z blue: seams, flipped or faceted normals), overdraw (stacked transparent layers), wireframe (triangle density, floating or duplicated pieces).

Use it on the weakest shot of a sheet to see WHY it reads badly. lighting/unshaded/overdraw/wireframe are the engine's Viewport debug draw modes; normals uses an unshaded override material on a private copy (normal maps and alpha cut-outs are not applied) and works on every renderer. The caption names the method per view.

Returns the grid + caption. Read-only: the scene file, the open tab and the undo history are never touched (the render is an offscreen copy of the SAVED scene). The image arrives inline; the caption carries poses, labels and numbers. Failures are structured (failure_reason), never a silent fallback.
