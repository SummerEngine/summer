---
name: choose-where-players-play
description: "Ask where people will play a new game (Summer Games app, desktop/Steam, consoles) before coding; it decides language, renderer, controls and testing."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: Read Grep Glob summer_project_setting summer_get_diagnostics
paths: ["project.godot", "export_presets.cfg", "**/*.gd"]
---

# Choose where players will play

The first question for any new game is **where people will play it**. The answer locks in the
code language, the renderer, the controls and how you test. Changing it after the game is built
means rewriting code or redoing the art, so ask before scaffolding anything.

Most creators build and test in one place first. That is fine, but pick the final destination now.

## 1. Ask the user one question

> Where do you want people to play this game?
> A. Everywhere, in the Summer Games app: iPhone, Android, web browser, and desktop
> B. Desktop only: Steam, Mac, Windows, Linux
> C. Its own store app or a console (PlayStation, Xbox)

Several answers are fine. The strictest one decides the rules below.

## 2. What each answer locks in

| Destination | Game code | Why |
|---|---|---|
| Summer Games app (phones, web, desktop app) | **GDScript only** (typed) | The app downloads each game as data and runs it in one shared engine. Phone stores do not allow an app to download new native code, so C++ or C# game code would need a new app release for every game update. |
| Desktop / Steam / Linux (own build) | GDScript by default; **C++ allowed** for hot loops | The game ships its own executable, so compiled code is fine. Use it where profiling shows GDScript is too slow (tight loops over thousands of objects), not by default. |
| Own store app | C++ allowed | The code is compiled into that app. Every code change is an app store update. |
| Consoles | Not self-serve yet | Needs platform-holder developer access and a console export path. Confirm with Summer before promising it. |

Rules that follow:
- Write GDScript with static types everywhere (`var speed: float = 4.0`, typed function signatures).
  Turn untyped-declaration and unsafe-access warnings into errors in Project Settings so mistakes
  fail early.
- Heavy systems that many games need (procedural foliage, large crowd simulation) belong in the
  engine as C++, where every game gets them, not in one game.
- Performance in GDScript is fine for most games: rendering, physics and streaming already run
  as engine C++. What is slow is your own tight per-frame loops over very many objects.

## 3. Renderer

- **Desktop:** Forward+.
- **Web:** Forward+ on Summer's WebGPU renderer.
- **Phones:** the engine can include both Metal (Forward+ / Mobile) and OpenGL (Compatibility).
  Each game picks one with `rendering/renderer/rendering_method.mobile`:
  - `forward_plus` or `mobile`: detailed 3D on modern phones.
  - `gl_compatibility`: simple or 2D games, lowest GPU load and battery use on weak phones.
  If this key is unset, phones use `mobile`, not Forward+.

Keep gameplay readable on the lightest renderer. Anything the player must see (a ripe crop, an
enemy, a mutation) must not depend only on glow, screen-space reflections, volumetric fog or
other Forward+-only effects; use shape, color and icons too.

Preview the lightest renderer on your computer:

```
<summer-binary> --path <project> --rendering-method gl_compatibility
```

Trust the renderer name the engine prints at startup, not the project setting. A device can fall
back to a different renderer if it lacks a capability.

## 4. Controls

| Destination | Must support |
|---|---|
| Phones | Touch: on-screen movement, camera drag, large tap targets, safe areas, no hover-only info |
| Desktop | Keyboard and mouse, plus a gamepad |
| Web | Focus loss, pointer lock, sound starting only after the first click or tap, touch on phone browsers |
| Consoles | Gamepad only, platform button prompts |

Map every action through Input Map actions, never raw keys, so one action works from every device.

## 5. Multiplayer

Use Summer's multiplayer service for anything that ships in the Summer Games app. It is what makes
phone, web and desktop players meet in one game. Do not hand-build networking by creating a peer and
connecting to an IP address: that only works on a local network and cannot use Summer hosting.

Keep the server in charge: clients send what they want to do ("plant here", "buy this"), the
server checks it, changes the state and tells everyone. See `host-authoritative-state`.

## 6. How to build and test for several destinations

1. **Every day:** run and test on your own computer. For multiplayer, run two copies side by side.
2. **At each milestone:** export to every chosen destination and play the core loop once on each.
   Check the printed renderer, touch controls and that two players from different destinations
   can join the same game.
3. **Before release:** a real device for each destination: a phone, a browser on a phone, and the
   desktop platforms you support.

Do not leave the other destinations until the end. Most surprises (renderer differences, touch,
browser audio rules) are cheap to fix early and expensive late.

## Common mistakes

- Game logic written in C++ or C# for a game meant for the Summer Games app. It cannot be downloaded
  onto phones.
- Believing a Forward+ project runs Forward+ on phones. Check `rendering_method.mobile`.
- Important information shown only through glow or color.
- Networking written against an IP address instead of Summer's multiplayer service.
- Testing only on desktop until launch week.

## See also

- `export-and-ship`: producing the builds once destinations are chosen.
- `host-authoritative-state`: who owns what in a multiplayer game.
- `tune-performance`: finding what is actually slow before reaching for C++.
