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

It is **not** the same as two neighbours:

| Action | What it does | Use it for |
|---|---|---|
| **Play** (▶) | Runs in the editor (embedded or windowed) | Fast iteration on the dev machine |
| **Remote Deploy** | Debug build → installs + runs on a device, remote-debugged | Testing real input/perf/screen on hardware |
| **export-and-ship** (`summer:export-and-ship`) | Final, signed distribution builds | Submitting to stores |

If the user wants a release build for Steam / itch / the App Store, that is `summer:export-and-ship`, not this.

## Where it is in the UI

- **Agent-layout topnav:** the button with the remote-play icon, immediately right of the **Play/Stop** button and the **`▾`** run-options dropdown. Hover tooltip reads **"Remote Deploy"**.
- Clicking it opens a **dropdown of detected targets**, grouped by platform (e.g. an `Android` header with each connected device under it). Picking a target deploys and runs there.
- It is **disabled (greyed out)** with the tooltip **"No Remote Deploy export presets configured."** until the prerequisites below are met. A greyed button is the #1 thing users ask about — it almost always means "no runnable preset or no device detected," not a bug.

## Prerequisites — what makes the button light up

The button auto-enables the moment a runnable preset **and** at least one detected target both exist for the same platform.

| Requirement | How to satisfy it | Why it matters |
|---|---|---|
| A **runnable export preset** for the platform | Project → Export → add a preset (Android / iOS / Web / desktop) → toggle **Runnable** on | The dropdown only lists platforms that have a *runnable* preset. A preset that exists but isn't marked Runnable does **not** count. |
| **Export templates** installed for that platform/engine version | Export dialog → **Manage Export Templates…** → download | Needed to actually build the debug build when you deploy. |
| The platform **toolchain** | Android: Android SDK + `adb` + a debug keystore. iOS: Xcode + signing. Web: any browser. | The deploy step shells out to these; without them the build can't be installed/run. |
| A **detected target** | Android: a device with USB debugging enabled (and authorized), or a running emulator. iOS: a connected, trusted device. Web: the built-in **"Run in Browser"** target. | The button enables only when ≥1 target is reported for a runnable platform. |

**Important nuance:** the button does **not** pre-check that templates/toolchain are installed. Enable state is gated only on *runnable preset + detected target*. If templates or the toolchain are missing, the deploy **fails at run time** and the errors appear in a result dialog. So:

> **Runnable preset + a detected device make the button appear/enable. Installed export templates make the deploy actually succeed.**

This matters when guiding a user mid-setup (e.g. building out a mobile flow): you can see the button enable as soon as a phone is plugged in and the preset is Runnable, even before templates finish downloading.

## How it works (the flow)

1. The editor continuously polls the export platforms and rebuilds the dropdown: each runnable platform, with each of its detected devices listed underneath.
2. The user picks a target. Godot exports a **debug** build for that preset.
3. The build is installed and launched on the device (e.g. `adb install` + launch for Android).
4. The running game opens a **remote-debug** connection back to the editor — Output, the debugger, and the profiler reflect the on-device session. Stop it from the editor like any normal run.
5. Any export/deploy error (missing template, no toolchain, unsigned build, device went away) is surfaced in a **result dialog**. Read it; it names the prerequisite to fix.

## Mobile quick paths

**Android**
1. Enable Developer Options → USB debugging on the phone; plug it in; accept the "Allow USB debugging?" prompt.
2. Confirm `adb devices` lists it as `device` (not `unauthorized`).
3. Project → Export → Android preset → **Runnable** on; install Android export templates.
4. The phone appears in the Remote Deploy dropdown → pick it.

**iOS**
1. Connect and trust the device; ensure a valid signing team in the iOS preset.
2. Xcode command-line tools installed; iOS export templates installed.
3. The device appears in the dropdown → pick it.

**Web (sanity check on the target browser)**
1. Web (HTML5) preset → **Runnable** on; Web export templates installed.
2. Pick **"Run in Browser"** from the dropdown.

## Guiding the user (orchestrator playbook)

When a user says "deploy to my phone" / "run this on device" and the button is greyed:

1. **Check the build is healthy first** — a project with script errors won't export.
   - `summer_get_script_errors` and `summer_get_diagnostics` clean? If not, fix those before anything else.
   - `summer_get_console` for "import failed" noise.
2. **Confirm a runnable preset exists** for the target platform — Read/Grep `export_presets.cfg` for the platform and a `runnable=true` entry. If missing, walk them through Project → Export → add preset → mark Runnable.
3. **Confirm the main scene is set** — `summer_project_setting` / `project.godot` `application/run/main_scene`. A deploy to a blank main scene launches to nothing.
4. **Confirm export templates + toolchain** for the platform are installed (Manage Export Templates; adb/Xcode/browser).
5. **Confirm a device is detected** — plugged in, debugging enabled, authorized.
6. Then point them at the topnav **Remote Deploy** button → pick the device.

Order matters: preset → templates/toolchain → device. Resolve them top-down; the button enables as soon as preset + device are both true, and the deploy succeeds once templates/toolchain are present.

## Common mistakes

- **Confusing it with shipping.** Remote Deploy makes *debug* builds for testing. Store/distribution builds are `summer:export-and-ship`.
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
