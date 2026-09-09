---
name: remote-deploy
description: Use when the user wants to run or test the game on a real target instead of the editor — a phone, tablet, or another computer ("deploy to my phone", "run on device", "test on Android/iOS", "remote deploy", "one-click deploy", "play on hardware"). Covers the topnav Remote Deploy button, runnable export presets, export templates, and on-device remote debugging. Use when the Remote Deploy button is greyed out and the user wants to know why.
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: Read Grep Edit summer_project_setting summer_get_diagnostics summer_get_console summer_get_script_errors
paths: ["project.godot", "export_presets.cfg"]
---

# /remote-deploy — Test the Game on a Real Device

## Overview

Remote Deploy runs the game on an actual target device — a phone, tablet, or another machine — instead of inside the editor. It exports a **debug** build, installs and launches it on the device, and connects the running game back to the editor's debugger so the Output panel, errors, breakpoints, and profiler all work exactly like a local run.

**Core principle:** Remote Deploy is "Play, but on the hardware." Same debug loop, real device.

**Capability gate comes first:** before adding a Runnable preset or telling the
user to pick a device, inventory the exact Summer build's export templates and
the platform toolchain. A stock Summer 4.6.1 Mono install has only the macOS
template. It cannot export Web, and Android/iOS/Windows/Linux are unavailable
until a matching custom template or external build environment is configured.
Never recommend or attempt a Remote Deploy target that has not passed this
proof.

It is **not** the same as two neighbours:

| Action | What it does | Use it for |
|---|---|---|
| **Play** (▶) | Runs in the editor (embedded or windowed) | Fast iteration on the dev machine |
| **Remote Deploy** | Debug build → installs + runs on a device, remote-debugged | Testing real input/perf/screen on hardware |
| **export-and-ship** (`export-and-ship`) | Supported local release builds | Preparing an artifact for a separate user-controlled distribution workflow |

If the user wants a release build for Steam / itch / the App Store, that is `export-and-ship`, not this.

## Where it is in the UI

- **Agent-layout topnav:** the button with the remote-play icon, immediately right of the **Play/Stop** button and the **`▾`** run-options dropdown. Hover tooltip reads **"Remote Deploy"**.
- Clicking it opens a **dropdown of detected targets**, grouped by platform (e.g. an `Android` header with each connected device under it). Picking a target deploys and runs there.
- It is **disabled (greyed out)** with the tooltip **"No Remote Deploy export presets configured."** until the prerequisites below are met. A greyed button is the #1 thing users ask about — it almost always means "no runnable preset or no device detected," not a bug.

## Step 1 — prove the requested target is available

Use `summer_get_project_context` to identify the exact engine binary and
technical base, inspect its matching export-template directory, then check the
requested platform toolchain. Report one of:

- `available`: matching template and toolchain are present;
- `blocked`: name the missing template, toolchain, signing, or device
  prerequisite;
- `impossible on this build`: Web on the stock Mono build.

Stop on `blocked` or `impossible`. Route the user to template installation,
custom-template setup, or an external CI/device workflow. Do not add a preset
as if that made the target runnable.

## Step 2 — prerequisites for a proven target

The button auto-enables the moment a runnable preset **and** at least one detected target both exist for the same platform.

| Requirement | How to satisfy it | Why it matters |
|---|---|---|
| A **proven template and toolchain** | Complete step 1 | Without both, a visible target still fails at deploy time. |
| A **runnable export preset** for that proven platform | Project → Export → add the proven preset → toggle **Runnable** on | A preset that exists but isn't marked Runnable does **not** count. |
| A **detected target** | For example, an authorized Android device or a connected, trusted iOS device | The button enables only when at least one target is reported for a runnable platform. |

**Important nuance:** the button does **not** pre-check that templates/toolchain are installed. Enable state is gated only on *runnable preset + detected target*. If templates or the toolchain are missing, the deploy **fails at run time** and the errors appear in a result dialog. So:

> **Runnable preset + a detected device make the button appear/enable. Installed export templates make the deploy actually succeed.**

This matters when guiding a user mid-setup (e.g. building out a mobile flow): you can see the button enable as soon as a phone is plugged in and the preset is Runnable, even before templates finish downloading.

## Step 3 — deploy after proof (the flow)

1. The editor continuously polls the export platforms and rebuilds the dropdown: each runnable platform, with each of its detected devices listed underneath.
2. The user picks a target. Summer Engine exports a **debug** build for that
   preset when the matching template and toolchain are installed.
3. The build is installed and launched on the device (e.g. `adb install` + launch for Android).
4. The running game opens a **remote-debug** connection back to the editor — Output, the debugger, and the profiler reflect the on-device session. Stop it from the editor like any normal run.
5. Any export/deploy error (missing template, no toolchain, unsigned build, device went away) is surfaced in a **result dialog**. Read it; it names the prerequisite to fix.

## Mobile paths after capability proof

**Android**
1. First prove a matching Android template, Android SDK, `adb`, and debug
   signing are installed. Otherwise stop.
2. Enable Developer Options → USB debugging on the phone; plug it in; accept the "Allow USB debugging?" prompt.
3. Confirm `adb devices` lists it as `device` (not `unauthorized`).
4. Project → Export → Android preset → **Runnable** on.
5. The phone appears in the Remote Deploy dropdown → pick it.

**iOS**
1. First prove a matching iOS template, Xcode toolchain, and signing identity
   are installed. Otherwise stop.
2. Connect and trust the device; ensure a valid signing team in the iOS preset.
3. The device appears in the dropdown → pick it.

**Web**

Web is unavailable on the stock Summer Mono build. Do not add a Web Runnable
preset or direct the user to a browser target. Use ordinary local Play for a
sanity check, or first provision and verify a separate non-Mono-compatible
export environment.

## Guiding the user (orchestrator playbook)

When a user says "deploy to my phone" / "run this on device" and the button is greyed:

1. **Prove target capability first** — inspect the exact build's matching
   template directory and platform toolchain. Stop or route externally if
   either is absent; Web is impossible on the stock Mono build.
2. **Check the build is healthy** — a project with script errors won't export.
   - `summer_get_script_errors` and `summer_get_diagnostics` clean? If not, fix those before anything else.
   - `summer_get_console` for "import failed" noise.
3. **Confirm a runnable preset exists** for the proven target platform — Read/Grep `export_presets.cfg` for the platform and a `runnable=true` entry. If missing, walk them through Project → Export → add preset → mark Runnable.
4. **Confirm the main scene is set** — `summer_project_setting` / `project.godot` `application/run/main_scene`. A deploy to a blank main scene launches to nothing.
5. **Confirm a device is detected** — plugged in, debugging enabled, authorized.
6. Then point them at the topnav **Remote Deploy** button → pick the device.

Order matters: capability proof → healthy project → preset → device. The
button can enable before the build is actually possible, so its visible state
never replaces the proof.

## Common mistakes

- **Confusing it with shipping.** Remote Deploy makes *debug* builds for testing. Store/distribution builds are `export-and-ship`.
- **Preset exists but isn't Runnable** → button stays greyed. The Runnable toggle is the gate, not the preset's existence.
- **Expecting it to work without export templates** → button may be enabled (device detected) but the deploy then fails in the result dialog. Install templates.
- **Android device `unauthorized`** in `adb devices` → the device won't show as a target. Re-accept the USB-debugging prompt on the phone.
- **Trying to script it via MCP** — there is no `summer_*` tool that triggers Remote Deploy; it is a UI action. The orchestrator's job is to get the prerequisites green and point the user at the button.

## Quick reference

| Button state | Meaning | Fix |
|---|---|---|
| Greyed, "No Remote Deploy export presets configured." | No runnable preset **or** no detected device | Add a Runnable preset; connect/authorize a device |
| Enabled, dropdown lists devices | Ready to deploy | Pick a device to build + run |
| Deploy fails in result dialog | Templates/toolchain/signing/device issue | Read the dialog; install the named missing piece |
