---
name: running-in-the-cloud
description: Use when Summer Engine runs in a cloud container, CI job, remote agent sandbox, or any Linux box with no desktop — installing the engine there, launching it headless, deciding when xvfb-run and software GL are required, and authenticating without a browser. Also use when a tool reports "engine not running" in an environment that has no display, or when SUMMER_ENGINE_BINARY / SUMMER_TOKEN come up.
---

# Running in the Cloud

## Overview

Summer Engine runs fine on a Linux machine with no display and no human. Everything in this skill was measured in a real cloud container: headless engine boots, MCP tools answer, and renders work under xvfb + llvmpipe.

Three facts carry the whole setup:

1. **Local engine ops need no login.** The engine mints its own API token (`~/.summer/api-token`, per-instance tokens in `~/.summer/instances/*.json`) on every launch. Scene mutation, inspection, play, diagnostics, headless scripting — all of it works with zero accounts.
2. **Only gateway features need a credential** — asset search, asset/image/3D generation, releases. In the cloud, pass it as an env var instead of a browser login.
3. **Most containers have no GPU and no Vulkan.** Pure headless work does not care. Anything that produces pixels needs a virtual display and software GL.

## Install the engine

`summer install` on Linux (x86_64) resolves in this order:

| Priority | Source | When |
|---|---|---|
| 1 | `SUMMER_ENGINE_BINARY=<abs path>` | The container already carries a prebuilt engine binary (for example a source build's `bin/godot.linuxbsd.editor.x86_64`). Registers that binary — no download. |
| 2 | `SUMMER_ENGINE_URL=<url>` | Download any artifact URL: `.tar.gz`, `.zip`, or a raw executable. |
| 3 | (default) | The newest published Linux release artifact (`Summer-linux-x86_64-<tag>.tar.gz`). |

All three register the binary at `~/.summer/engine/summer-linux-x86_64`, which is where `summer run` and `summer doctor` look. `SUMMER_ENGINE_BINARY` is also honored directly at lookup time, so setting the env var alone (without ever running `summer install`) is enough for `summer doctor` to report the engine as installed.

```bash
# Container with a prebuilt binary — today's cloud unlock:
export SUMMER_ENGINE_BINARY=/abs/path/to/engine-binary
summer install      # registers it; summer doctor now shows Engine: ok
```

`summer doctor` is the readiness check: Engine, Local API, MCP tools. "Login: not signed in" is a warning, not a blocker — engine ops do not need it.

## Launch headless

```bash
<engine-binary> --headless --editor --path <project-dir>
```

That boots the real editor — import pipeline, local API server, MCP reachability — with no window and no display. Give it a few seconds, then `summer doctor` should show `Local API: :6550`.

- One-shot work (bake, import, export, scripted authoring) uses `--headless ... -s res://script.gd` — load `headless-scripting`, it is the authoritative guide including the crash-handler flag and the exit-code traps.
- **Boot → act → exit.** A long-lived headless editor never rescans the filesystem; it serves a boot-time snapshot forever.

### Instance discovery

Every running editor writes `~/.summer/instances/<id>.json` — pid, port, token, project root, heartbeat. The CLI and MCP discover engines through those files; stale entries (dead pid, old heartbeat) are ignored automatically. In a container you can read them yourself to find the port/token for raw HTTP against `http://127.0.0.1:<port>/api/...`.

## Pixels: when you need xvfb-run + software GL

`--headless` uses the dummy renderer: **no pixels, ever**. Any path that renders an image needs a real (virtual) display:

| Needs xvfb + GL | Pure headless is fine |
|---|---|
| `summer_screenshot` scene previews (ScenePreview images) | Scene mutation, inspection, scene tree reads |
| GameSnapshot / viewport captures | Diagnostics, script errors, console |
| RunVerification frames (`--summer-verify` probes) | Imports, exports, navmesh/collision baking |
| Anything judged by looking at a frame | Play/stop, project context, file ops |

Most cloud containers have no Vulkan device. The working recipe is X virtual framebuffer plus Mesa's software rasterizer (llvmpipe), driving the GL compatibility renderer:

```bash
apt-get install -y xvfb libgl1-mesa-dri   # names vary by distro
xvfb-run -a <engine-binary> --path <project-dir> --rendering-driver opengl3 ...
```

Honest limitations:

- **No Vulkan in most containers** → Forward+/Mobile renderers are unavailable; you get software GL (Compatibility). Colors and composition are trustworthy; GPU-specific effects, performance numbers, and driver-dependent output are not.
- Software rendering is slow. Budget seconds per frame, not milliseconds, and never quote FPS measured this way.
- If a render tool returns a null/blank image in a container, check for a display before suspecting the scene: no `$DISPLAY` means no pixels.

## Authentication without a browser

- **Engine ops: nothing to do.** The local API token is auto-generated; `summer login` is never required for them.
- **Gateway features** (asset search, generation, releases): set `SUMMER_TOKEN` to a CLI token from a logged-in machine (`~/.summer/auth-token`). It overrides the stored file for that process only.

```bash
export SUMMER_TOKEN="$(cat ~/.summer/auth-token)"  # gateway: assets/generation/releases
```

Treat it as a secret: env-inject it from the runner's secret store, never bake it into images or logs. Without it, gateway tools fail with a clear "not signed in" message — everything else keeps working.

## Red Flags — STOP

| Red flag | Reality |
|---|---|
| "Linux isn't supported, download manually" | `summer install` supports Linux x86_64; set `SUMMER_ENGINE_BINARY` when the container has its own build. |
| Running `summer login` in a container | There is no browser. Engine ops need no login; gateway needs `SUMMER_TOKEN`. |
| Screenshot/preview attempted under plain `--headless` | Dummy renderer, null image. Use `xvfb-run` + `--rendering-driver opengl3`. |
| Expecting Forward+ output in a container | No Vulkan device in most containers. Software GL (Compatibility) is what you get. |
| Quoting performance numbers from a software-GL run | llvmpipe measures the CPU, not the game. |
| Polling the engine before it finished booting | Give it seconds; watch `summer doctor` / `~/.summer/instances/`. |
| Baking a token into an image or committing it | Tokens are secrets. Env-inject at runtime. |

**Related skills:**
- `headless-scripting` — the headless invocation contract, exit-code traps, and what scripts unlock.
- `playtesting-a-feature` — the verify instance and probes (run them under xvfb in the cloud).
- `verification-before-completion` — judging work by artifacts, which matters double when nobody can see a screen.
