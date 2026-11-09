# concept-to-level: technical rules in detail

Each rule says what to do, why, and what went wrong without it. They come
from one long 3D arena build in Summer Engine with several agents working
on one map.

## The live editor

**Do not run heavy or reloading scripts in the live editor.** Recoding a
shader, reloading a scene, or instantiating and freeing a scene that an open
tab uses can hang the editor's main thread or crash it. We lost the editor
twice to a clearance checker run inside it, and once more to a script that
re-set shader code to refresh the cache ("Attempted to free invalid ID"
spam, main thread stuck). Use the editor for small property edits and
saves. Build meshes, bake data and run checks headless (see
`headless-scripting`), then let the editor import the named files.

**The editor keeps old shaders cached.** After a shader file changes on
disk, the open editor may still draw the old version. Do not force a reload
there; render from a fresh process instead.

**Edit an open scene only through the live editor.** If you text-edit the
`.tscn` on disk while it is open, the editor overwrites your change on its
next save, or saves its stale copy over yours. The reverse also happens:
pressing Play can save a stale open tab and resurrect deleted nodes. Close
tabs you are not editing.

**The editor rewrites some files on its own** (the project settings file,
some scenes and resources it touches on load). Check `git diff` before every
commit and stage only what you meant to change. To change one line of such a
file, build the commit content from the last commit plus that line rather
than staging the editor's whole rewrite.

## Rendering previews

**Render from a separate, short-lived engine process** that loads the map
from disk, takes the frames, and exits. It sees the current shaders and
meshes, cannot disturb the editor, and frees its memory when done.

**Call `RenderingServer.force_draw()` before reading the viewport image.**
Without it, later frames can come back identical to an earlier one when the
window stops drawing in the background.

**Watch for in-game UI covering the camera.** A level script may open a menu
(class select, lobby) that hides the scene. Render the scene with that
script disabled, or from an isolated viewport.

**Fixed angles.** Keep a small set of saved cameras per map: overview, eye
level from each spawn, each hero element close, from above. Reuse them so
before and after renders are comparable.

## Load

One heavy process at a time across all agents (imports, Blender, headless
runs, renders), at low priority. The machine overheating or the editor
freezing during a demo costs more than the time saved. See
`bounded-engine-runs` for time limits and muted runs.

## Online constraints

Check what the online build does to a map scene before designing effects.
In our project the online client rebuilt the map's visuals, turned any node
whose type contains "Particles" into a plain node, and ran no map scripts.
Consequences:

- Fire, sparks, smoke, motes: camera-facing mesh layers driven by shaders,
  with soft depth fades. No particle nodes.
- Animated set pieces (a statue floating against taut chains): bake the
  motion into a vertex animation texture and play it in the vertex shader.
  Set `custom_aabb` so the moving mesh is not culled. Zero CPU.
- Dynamic events: the server owns the state (timings, collision on or off);
  a client presenter drives the shader parameters from that state. Write the
  spec for the server with timings in ticks and the exact collision bodies.
- Lights survive, so cheap flickering lights are fine.

## Baked versus procedural

Bake what only needs to loop (statue, cloth idle). Make procedural what must
aim or react: god hands that point their beams at a moving target need an
aim layer (look-at or two-bone IK with damped, slightly overshooting motion)
on top of the base pose, with one API all events call.

## Fallbacks

When you swap an experimental asset into the map (the floating statue), keep
the previous scene file and say how to swap back. Do not swap untested
assets in right before a demo unless the user asks.

## Generated and third-party assets

Generated 3D models need cleanup: decimate to a budget, check normals and
inside-out meshes, merge or split parts deliberately, ground them on their
support, give every surface a real material (a chain that rendered white
had lost its material on import). Record each in the notices file with the
tool named and its terms marked "not confirmed" until checked.

Every third-party texture: source page, author, licence, download date,
what was changed. Never guess a licence.

## Modular kits

After every kit rebuild check: zero coplanar overlapping faces, all seams
welded (no gaps where pieces meet), a see-through scan with rays from inside
the play space, and the collision against the visible faces (within a few
cm). Rebuilds can change random block tones and baked shading on pieces you
did not mean to change: compare against the committed version and restore.

When splitting a kit piece out (to make it removable), copy its triangles
out of the exported files instead of regenerating it, prove the split looks
identical, and install the new pieces and the scene that uses them together.
Overwriting a repo piece first made parts of the live map vanish.

## Moving things

Moving a room or structure moves the job, not one node. Re-run or re-check
everything placed relative to it: decals (snap to the actual surface, drop
what no longer fits), banners and their hooks, backdrop rock under it,
spawn markers, collision, lights. Re-measure clearances, including cloth at
full sway against the floor below.

## Gameplay sync

After a collider, spawn or zone change: recompile the server's collision
artifact, update tests that hard-code positions, run the rules tests and the
contract check, and read their PASS lines. Spawns: centred on the axis,
mirrored exactly between teams (an exact 180 degree turn, not 180.56),
evenly spaced, facing the play space.

## Render cost

Count early and after each lane: vertices, triangles, mesh instances, draw
calls, shadow-casting surfaces, lights (and which cast shadows), decals.
Know the biggest offenders by group. In our map, eight decorative figures
seen only through bars were a quarter of all triangles; the fix was a
low-end note to hide them and a planned decimation. Typical cuts: decimate
hidden detail, merge kit pieces into fewer draws, no shadows on small
props, shorter sun shadow distance, half-resolution post effects.

## Dynamic events

- Agree the feel first: scale, speed, how long it stays, what the warning
  reveals. Big things move slowly, with anticipation and a held impact.
- Telegraph fairly but not too precisely: a warning that draws the exact
  path is too easy to dodge.
- Check the event never makes the play space impassable and never kills
  without warning.
- Make what the player sees match what happens: a hole that is open in the
  collision but painted over by a glow reads as solid floor.
- In a showcase or demo loop, reset destroyed pieces so the effect can be
  watched again.
