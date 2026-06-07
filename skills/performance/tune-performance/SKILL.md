---
name: tune-performance
description: Use when the user reports the game is slow, drops framerate, stutters, takes forever to start, or runs poorly on specific hardware. Profiles the running game via summer_get_diagnostics, identifies hotspots (rendering / physics / scripting), and proposes specific fixes with before/after metric expectations. Trigger on "slow", "lag", "fps drop", "stuttering", "performance", "optimize", "profile", "framerate".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: performance
user-invocable: true
allowed-tools: Read Grep Glob Edit summer_get_diagnostics summer_get_console summer_get_scene_tree summer_inspect_node summer_inspect_resource summer_play summer_stop summer_is_running summer_clear_console summer_set_prop summer_project_setting
paths: ["**/*.gd", "**/*.tscn", "**/*.tres", "project.godot"]
---

# /tune-performance — Profile, Diagnose, Fix

## Overview

Performance tuning without measurement is gambling. This skill enforces a measure-first loop: read diagnostics, identify the dominant cost (rendering / physics / scripting / startup), drill into the specific pattern, propose one fix, verify the metric moved. No shotgun optimization.

**Core principle:** the engine's diagnostics tell you which subsystem is bleeding. Don't optimize a different subsystem.

## Steps

### 1. Get the user's symptom precisely

> What's slow? Pick the closest: framerate drops in scene X / startup is long / freezes for a moment / runs fine on my machine but bad on hardware Y.

Wait. The answer narrows the fix domain by 5x:

| Symptom | Likely subsystem |
|---|---|
| Framerate drops as more enemies spawn | Scripting (`_process` per-instance) or physics |
| Framerate is fine standing still, drops looking at level X | Rendering (overdraw, draw calls, lights) |
| Stutter every N seconds | GC pause, autoload loop, or async load |
| Long startup | Asset import, autoload `_ready` work, shader compilation |
| Runs fine on dev machine, bad on user machine | Resolution, GPU features (compute, GI), shadow quality |

### 2. Take a baseline measurement

Don't guess. Read the engine's actual numbers.

**Preferred (Summer MCP):**

```
summer_clear_console
summer_play
# user reproduces the slowdown for 5–10 seconds
summer_get_diagnostics
summer_get_console               # check for warnings (e.g. "shader compilation hot-path")
summer_stop
```

`summer_get_diagnostics` returns the aggregate metrics. Note (write down before fixing anything):

- Average FPS during the slow section
- Frame time (ms) — anything over 16.67 ms = below 60 fps
- Draw calls per frame
- Active physics bodies
- Active GPUParticles instances
- Script time vs. physics time vs. render time

**Fallback (no MCP):** ask the user to enable Godot's built-in monitor (`Debug → Monitor` or in-game with `Performance.get_monitor`) and paste numbers. At minimum: FPS, frame time, draw calls, physics active objects.

### 3. Identify the dominant cost

The biggest number wins your attention. Don't optimize the second-biggest — that's a 5% win when 30% is sitting next to it.

Decision tree:

- **Render time > 50% frame budget** → rendering hotspot (Step 4a)
- **Physics time > 30% frame budget** → physics hotspot (Step 4b)
- **Script time > 30% frame budget** → GDScript hotspot (Step 4c)
- **Frame time spikes (jitter) but average is fine** → GC / shader compile / async (Step 4d)
- **FPS is fine but startup is slow** → import / autoload (Step 4e)

### 4a. Rendering hotspot

Common Godot 4.5 rendering costs, ordered by frequency:

| Pattern | Symptom | Fix |
|---|---|---|
| Too many MeshInstance3D | Draw calls > 1000 | MultiMeshInstance3D for repeated meshes (foliage, debris). 5000 trees = 1 draw call. |
| Overdraw (transparent stacked) | Render time spikes when looking at particles/glass/UI | Reduce particle `amount`, disable `transparent` on opaque materials, check Compositor settings |
| Real-time lights > 4 visible | Frame time doubles in well-lit rooms | Bake static lighting (`LightmapGI`), make distant lights `shadow_enabled = false` |
| Shadow map size too high | Render time spikes near light sources | DirectionalLight3D `directional_shadow_max_distance` lower, OmniLight3D shadow_bias up, shadow size 2048 → 1024 |
| No occlusion culling | Far rooms drawn through walls | OccluderInstance3D + bake. Painful but high-impact for indoor scenes. |
| Missing LOD on complex meshes | Drop in framerate when far away | MeshInstance3D `visibility_range_begin` + manual LOD swaps |

To inspect a suspect node:

```
summer_inspect_node "./World/Enemy"
summer_inspect_resource "./World/Enemy"   # for mesh/material/shape details
```

### 4b. Physics hotspot

Top patterns:

| Pattern | Fix |
|---|---|
| 100+ active RigidBody3D | Sleep them when idle (`can_sleep = true`), or convert to Area3D where collision response isn't needed |
| Concave collision shapes on dynamic bodies | Convert to ConvexPolygonShape3D or compound primitives (sphere/capsule/box). Concave costs 5–20x more. |
| Physics tick at 120 Hz default | Lower `physics/common/physics_ticks_per_second` to 60 if visual smoothness allows |
| Per-frame raycast in `_physics_process` | Cache the result, raycast every N frames, or use ShapeCast3D |
| Hundreds of overlap queries | Use Area3D with `monitoring = true` only on the bodies that need to detect — turn it off on environment |

### 4c. GDScript hotspot

Per-frame work in `_process` is the #1 GDScript cost. Read the script, look for:

```gdscript
# BAD — runs every frame
func _process(delta: float) -> void:
    var enemies = get_tree().get_nodes_in_group("enemies")  # tree walk!
    for enemy in enemies:
        var dist = global_position.distance_to(enemy.global_position)
        if dist < 10.0:
            ...
```

Fixes:

- Cache the group lookup in `_ready()` if the group composition is stable.
- Move per-frame work to a timer at 10 Hz (`_on_timer_timeout`), not 60 Hz.
- Replace `distance_to` with `distance_squared_to` in comparisons (no sqrt).
- Push hot loops to a `@tool`-able C# script or GDExtension if it's truly per-frame.

### 4d. Frame time spikes (jitter)

If FPS is good but frame time spikes:

- **Shader compilation**: precompile shaders during loading screen via `RenderingServer.shader_compile_from_code` or by warming up the scene off-screen.
- **GC / object allocation**: `var x := []` inside `_process` allocates each frame. Pre-allocate.
- **Async resource load**: ensure `ResourceLoader.load_threaded_request` is finished before referencing.

Check `summer_get_console` for shader-compile warnings.

### 4e. Startup time

```
summer_clear_console
summer_play
# stop after first scene loads
summer_stop
summer_get_console
```

Look for:

- Long autoload `_ready()` work (move to `call_deferred` or background thread).
- Asset import on first run (cache `.import` files in source control).
- `preload()` of huge scenes at script-parse time — switch to `load()` on demand.

### 5. Propose ONE fix with a metric expectation

Don't bundle five fixes. Pick the highest-leverage one.

> The dominant cost is **rendering** at 14.2 ms / frame (85% of budget). The biggest source is 240 individual MeshInstance3D for foliage. Replacing them with one MultiMeshInstance3D should drop render time to ~3 ms (estimate: 5–7 ms). May I refactor `./World/Foliage` to use MultiMeshInstance3D?

Format the proposal as: (a) what the dominant cost is, (b) the specific source, (c) the fix, (d) the expected metric movement, (e) the ask.

### 6. Apply, re-measure, report

After the user approves:

```
# apply the fix (Edit / summer_add_node / summer_set_prop / etc)
summer_save_scene
summer_clear_console
summer_play
# user reproduces the same scenario
summer_get_diagnostics
summer_stop
```

Compare: was the metric movement at least 50% of what was promised? If yes, ship it. If no, the hypothesis was wrong — go back to step 3 with the new numbers.

> Before: 14.2 ms render / 22 fps. After: 4.1 ms render / 58 fps. Shipped.

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Optimize without baseline metrics | Always `summer_get_diagnostics` before and after | "Felt faster" is not a measurement |
| Fix the second-biggest cost | Fix the biggest first, re-measure, re-prioritize | Amdahl's law — the small win evaporates next to the big one |
| Bundle 5 fixes into one PR | One fix at a time, verify each | Bundles hide regressions. Hard to attribute the win or the loss. |
| `_process` for everything | 10 Hz timer for AI / distance checks / range polls | 60 Hz AI is wasted CPU |
| `distance_to` in hot loop | `distance_squared_to` in comparisons | sqrt is expensive at scale |
| 200 RigidBody3D for debris | MultiMeshInstance3D + manual physics, or bake | Each rigid body = solver work every tick |
| Real-time GI everywhere | Bake static lighting; real-time only for movable lights | Real-time GI is a per-frame budget killer |
| Shadow map at 4096 on every light | 4096 for sun, 1024 or off for fillers | Shadow map writes are hidden render passes |
| Concave shape on dynamic body | Compound primitives (sphere + box + capsule) | Concave shape physics is 5–20x slower |
| `get_nodes_in_group` every frame | Cache once in `_ready()` | Tree walks aren't free |

## Anti-patterns from the field

- **"Just disable VSync to see real FPS."** Disabling VSync helps you measure, but performance work targets perceived smoothness (16.7 ms, locked). Re-enable before shipping.
- **Premature C++ rewrite.** A GDScript hotpath at 5% of frame time isn't the bottleneck. Profile first.
- **"It's slow on user machines, must be the GPU."** Often it's resolution scale + shadow quality + GI settings. Add a quality preset switcher first.
- **Threading gameplay code.** Godot's gameplay layer isn't thread-safe. Threading is for asset load, network, AI compute — not `_physics_process`.

## Collaborative protocol

This skill makes scene/resource/code changes. Always ask before each fix is applied. See `references/collaborative-protocol.md`.

## Want a working starter?

No template — this is a workflow. Performance tuning is project-specific by definition.

## See also

- `references/mcp-tools-reference.md` — full MCP tool list
- `references/godot-version.md` — Godot 4.5 renderer notes (Compositor, RenderSceneBuffers churn)
- `references/collaborative-protocol.md` — "May I write" pattern
- `references/gd-style.md` — GDScript conventions (avoid bare types, use `:=`)
- `performance/profiling-godot/SKILL.md` — deeper Godot profiler usage
- `performance/draw-call-batching/SKILL.md` — MultiMeshInstance3D patterns
- `performance/lod-and-culling/SKILL.md` — LOD setup
- `debugging/debug/SKILL.md` — bug triage (related but different)
- `rendering-and-lighting/baked-vs-realtime-lighting/SKILL.md` — bake decisions
