---
name: export-and-ship
description: Use when the user wants to assess or prepare a Summer game export. Inventories the templates and targets actually available in the installed Summer Engine build, validates release assets and configuration, and produces only locally supported builds after approval. It does not publish, upload, host, or submit a game. Trigger on "export", "ship", "release", "build", "Steam", "itch", "HTML5", "iOS", "Android", "submit", "publish".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_get_scene_tree summer_inspect_node summer_project_setting summer_get_console summer_get_diagnostics
paths: ["**/*.gd", "**/*.tscn", "project.godot", "export_presets.cfg", "**/*.png", "**/*.svg", "**/*.icns", "**/*.ico"]
---

# /export-and-ship — Export and Prep Distribution

## Overview

Shipping is a checklist, not a creative act. This skill first inventories the
export templates and targets actually present in the installed Summer Engine
build. It can then validate platform-specific assets and configuration and
produce a local build for an available target after approval. It does not
upload, host, submit, or promise a target that is absent from the installation.

**Core principle:** prove the target is locally available, then read its list,
satisfy the list, and build. Treat store submission and hosting as separate
user-controlled workflows.

## Steps

### 1. Prove local export capability

Do this before presenting destinations, writing presets, or constructing an
export command.

1. Read `engineBinaryPath` from `summer_get_project_context`.
2. Resolve the matching export-template directory for that exact Summer
   technical base.
3. Inventory the installed templates and any `custom_template/release` paths
   already configured in `export_presets.cfg`.
4. Build a capability table with `available`, `missing prerequisite`, or
   `impossible on this build` for every requested target.

A stock Summer 4.6.1 Mono install has only the macOS template. Web export is
incompatible with that Mono build. Windows, Linux, Android, and iOS require a
matching custom template or an external CI/build environment, plus their
platform toolchains where applicable.

**Hard gate:** an absent template or toolchain means the target is unavailable.
Do not create its preset, recommend it as a local option, or invoke an export
command. Route it to an explicitly configured external CI job or stop and tell
the user which prerequisite is missing. An export pack is not a runnable
platform build and must not be presented as one.

### 2. Pick among proven destinations

Offer only targets marked `available` by step 1. Record other requested
destinations as blocked follow-ups with their exact prerequisite.

> Locally proven targets: **macOS**. Requested but blocked: **Windows**
> (matching template or external CI), **Web** (non-Mono build), **Android**
> (template + Android toolchain). Which proven target should I prepare?

Each destination has a different list. Multiple destinations = multiple lists. Don't shortcut — the iOS list does not satisfy the Steam list.

### 3. Run the pre-flight checklist

Always do this first, regardless of destination.

**Preferred (Summer MCP):**

```
summer_get_diagnostics            # any errors? if yes, abort.
summer_get_console                # any "import failed" warnings?
summer_get_scene_tree             # is the main scene set?
```

**Fallback (no MCP):** ask the user to confirm in Summer Engine: Project →
Project Settings → Application → Run → Main Scene is set, and the Output panel
has no errors.

#### Pre-flight blockers (any one = stop)

| Check | How | Blocker because |
|---|---|---|
| Main scene is set | `project.godot` has `application/run/main_scene` | Game launches to nothing without it |
| No script errors | `summer_get_script_errors` clean | Won't compile in export |
| No `print()` debug spam in hot loops | `Grep "print(" -- "**/*.gd"` | Spammy console for users |
| No hardcoded debug paths | `Grep "user://debug" or "/Users/" or "C:\\\\"` | Breaks on user machines |
| `.gitignore` excludes `.godot/`, `.import/`, `*.tmp` | Read `.gitignore` | Build artifacts in repo |
| LICENSE file present | Read `LICENSE` at repo root | Steam + itch require licensing clarity |
| `attribution.md` for community assets | Read `attribution.md` or equivalent | CC-BY assets need credit; missing = takedown risk |
| Version number set | `application/config/version` in `project.godot` | Required by Steam, useful everywhere |
| Game name set | `application/config/name` | Window title, build artifact name |

If any check fails, list them in one message and ask:

> Pre-flight failed on N items: <list>. Fix these before exporting? I can take them one by one.

### 4. Per-platform distribution requirements

These lists describe distribution requirements only. They do not establish
local export capability. Walk a list only after step 1 proves its target or
the user has selected an external build environment that does.

#### a) Steam

| Asset | Resolution | Format | Path / use |
|---|---|---|---|
| Game icon | 256×256 | PNG, transparent | Used in Steam library, taskbar |
| Library capsule | 600×900 | PNG | "Box art" in library grid |
| Library hero | 3840×1240 | PNG | Wide banner at top of game's library page |
| Library logo | 1280×720, transparent BG | PNG | Title overlay on hero |
| Header capsule | 460×215 | PNG | Store search results, friend activity |
| Main capsule | 616×353 | PNG | Front-page features |
| Small capsule | 231×87 | PNG | Sidebar |
| Page background | 1438×810 | JPG | Behind store page content |
| Screenshots | ≥ 1280×720, 16:9 | PNG/JPG | At least 5 |
| Trailer | 1080p, MP4, ≤ 2 min | MP4 | Required for Coming Soon → Released |
| Steam page text | English required + any localized | Markdown / plaintext | Short description (300 chars), full description, controls |

Build config for Steam:

- Export only the platform builds proven in step 1. Additional Steam platforms
  require their own matching template or external build job.
- Export options: `Embed PCK = true` for single-EXE distribution.
- Steam SDK integration: GodotSteam (`https://godotsteam.com`) is the standard. Add the GDExtension before exporting.
- App ID must be set in the Steam SDK init code.
- Build separately for each platform; Steam Pipe uploads handle distribution.

#### b) itch.io

Lower bar than Steam. itch is forgiving.

| Asset | Resolution | Required? |
|---|---|---|
| Cover image | 630×500 | Yes |
| Screenshots | Any 16:9 | At least 3 |
| Game title + tagline | text | Yes |
| Description | Markdown | Yes |
| Build files | ZIP per platform OR `butler` upload | Yes |

Build config:
- Package each proven platform build as a ZIP.
- Or use `butler push` (itch's CLI) for atomic versioning and patches.
- A browser build is optional and requires a separately proven non-Mono Web
  export environment.

#### c) Web (HTML5) — unavailable on the stock Mono build

Do not recommend or attempt this target from the stock Summer installation.
Route it to a verified non-Mono Summer-compatible build environment first.
Once that prerequisite is proven, these browser constraints apply:

- No threading without `cross-origin-isolated` headers (most hosts don't set them).
- No ENet — use WebSocket / WebRTC if multiplayer.
- Long initial load — first-paint is critical. Add a loading screen.
- File size matters — strip unused features in export preset (no encryption, no debugging, no JavaScript eval if not needed).

Build config:
- Export preset: **Web**.
- Output `.html` + `.wasm` + `.pck` + `.js`.
- Disable: "Variant: Editor support", "Encryption". Keep: "GLES3 Fallback to GLES2" if targeting old browsers.

Known traps:
- Audio: Chrome blocks autoplay. First user click must trigger audio context resume.
- Local saves: use `user://` (maps to IndexedDB on web). Test that saves persist across reload.

#### d) iOS App Store

| Asset | Resolution / Format |
|---|---|
| App icon | 1024×1024 PNG (Apple generates the rest) |
| Launch screen | Storyboard (Godot generates) |
| Screenshots | 6.5" iPhone: 1242×2688 / 2688×1242 (≥ 3); 12.9" iPad if iPad-eligible |
| App Store description | text per locale, ≤ 4000 chars |
| Keywords | ≤ 100 chars, comma-separated |
| Support URL | required |
| Privacy policy URL | required (any data collection) |

Build config:
- Export preset: **iOS**.
- Bundle ID: `com.<your-org>.<game-name>`. Must match Apple Developer portal.
- Apple Developer account required ($99/year).
- Code signing: distribution certificate + provisioning profile.
- Build via macOS only (Xcode toolchain).
- TestFlight first (always). Don't go straight to App Store review.

#### e) Google Play (Android)

| Asset | Resolution / Format |
|---|---|
| App icon | 512×512 PNG (32-bit, transparent) |
| Feature graphic | 1024×500 PNG |
| Phone screenshots | 16:9 or 9:16, ≥ 1080p, ≥ 2 |
| Tablet screenshots | optional but boosts visibility |
| App description | text per locale, ≤ 4000 chars |
| Short description | ≤ 80 chars |

Build config:
- Export preset: **Android**.
- Build as **AAB** (Android App Bundle), NOT APK — Play Store requires AAB since 2021.
- Signing: Play App Signing (Google holds the key) + an upload key.
- Target API level: latest required by Play Store policy (typically the previous year's API level).
- Test on real device + emulator before submission.

#### f) macOS DMG (outside Steam)

- Export preset: **macOS** (universal binary).
- Codesign + notarize via Apple — unsigned builds get a Gatekeeper warning users can't easily bypass.
- Notarization requires Apple Developer account ($99/year).
- DMG packaging: `create-dmg` CLI or `hdiutil`.

#### g) Windows installer (outside Steam)

- Export preset: **Windows Desktop** (x86_64).
- Code-signing certificate ($75–$300/year from a CA) — without it, SmartScreen flags the EXE.
- Installer: NSIS or InnoSetup are the standards. Or just ship a ZIP.

### 5. Build config consistency check

Before producing builds, verify `export_presets.cfg` for each target:

```
Read export_presets.cfg
```

For each preset:

| Field | Production value | Why |
|---|---|---|
| `binary_format/embed_pck` | `true` | Single EXE per platform |
| `texture_format/etc2_astc` | `true` for mobile | Smaller texture compression |
| `application/short_version` | matches `application/config/version` | Steam reads it |
| `script_encryption_key` in `export_credentials.cfg` | set only when the user explicitly chooses script encryption | The similarly named preset field does not exist |
| `application/icon` | path to your `.ico` / `.icns` / `.png` | Otherwise generic Godot icon ships |

### 6. Propose the build sequence

> Capability proof: macOS available locally; Windows and Linux require external
> CI; Web is unavailable on this Mono build. Pre-flight is clean for the macOS
> preset. May I produce that one proven build now?

### 7. Produce a proven build

CLI export is the standard scripted path. **Get the binary from `summer_get_project_context` → `engineBinaryPath`.** Do not type an engine binary name from memory:

- There is no `godot` on a Summer user's machine.
- `summer` is the npm CLI, not the engine. It takes subcommands and would never accept `--export-release`.
- On macOS the engine is `/Applications/Summer.app/Contents/MacOS/Summer`; on Windows, `%LOCALAPPDATA%\Summer\current\Summer.exe`.

After step 1 has marked a preset `available`, substitute only that exact proven
preset and output:

```bash
ENGINE=<engineBinaryPath>
PROJ=<absolute project dir>
PROVEN_PRESET=<exact available preset name>
PROVEN_OUTPUT=<output path valid for that target>

"$ENGINE" --headless --path "$PROJ" --export-release "$PROVEN_PRESET" "$PROVEN_OUTPUT"
```

`--path` is not optional in a script — without it the export targets the current working directory.

The quoted preset name must match a `name=` in `export_presets.cfg` exactly. That file is plain text you can write yourself if it is missing: a hand-written preset plus this command was measured producing a runnable 144 MB `.app`, exit code 0.

To enable another target, prove one of these before returning to step 2:

- a matching installed export template;
- a valid `custom_template/release="<path>"` for the current technical base;
- an external CI/build job with the matching template and platform toolchain.

### Export-option cautions

- **`script/encryption_key` does not exist.** The real key is `script_encryption_key`, and it lives in a separate `export_credentials.cfg`, not `export_presets.cfg` (`editor/export/editor_export.cpp:101,372-373`). Writing the wrong name produces an **unencrypted build with no error at all**.
- **There is no `debug` field in a preset.** Debug versus release is chosen by `--export-debug` versus `--export-release`, nothing else.

On Apple Silicon, `binary_format/architecture="arm64"` is the natural guess, and it fails leaving a **0-byte `.app` that looks like success**. Only `"universal"` ships.

See `headless-scripting` for the wider pattern this is one instance of.

If the user is on a CI system (GitHub Actions etc), this is the right place to point them at a cross-compile workflow — Godot can export Windows + Linux from a Linux runner.

### 8. Verify each build

For each build:
- Launch it. Confirm the title screen renders.
- Run for 30 seconds. Confirm no console errors.
- Check the file size (anything over 500 MB needs justification — usually unstripped textures or unused assets).
- For mobile: install on a real device, not just the emulator.

### 9. Hand off distribution

Per platform, point the user at the correct upload path:

- **Steam:** `steamcmd` + Steam Pipe (`builder_app_xxx.vdf`). Set up depots first in Steamworks.
- **itch.io:** `butler push <path> <user>/<game>:<channel>` (e.g. `butler push build/win <user>/mygame:windows`).
- **Web (itch hosted):** zip + drop into itch upload UI as "playable in browser".
- **iOS:** Archive in Xcode → upload via Xcode Organizer → TestFlight → App Store.
- **Android:** Play Console → Internal testing → Closed → Open → Production.

Skill does NOT execute these uploads itself. It produces the builds and points at the right command.

## Pre-flight checklist (master)

Use this as a one-shot grep before any export:

| Check | Pass condition |
|---|---|
| Main scene set | `project.godot` has `application/run/main_scene = "res://..."` |
| No script errors | `summer_get_script_errors` empty |
| No debug `print()` spam | Grep returns < 20 hits across project (or each is intentional) |
| No hardcoded user paths | Grep for `/Users/`, `C:\\`, `/home/` returns 0 hits |
| Version number set | `application/config/version = "1.0.0"` (or higher) |
| Game name set | `application/config/name = "<actual name>"` |
| Icon assets present | Per-platform icon files exist at the paths referenced in `export_presets.cfg` |
| LICENSE file | Exists at repo root |
| Attribution file | Exists if any community assets used |
| Release mode selected | Build invocation uses `--export-release` |
| Export preset `embed_pck = true` | For all desktop release presets |
| `.gitignore` excludes build artifacts | `build/`, `.godot/`, `.import/`, `*.tmp` listed |
| Screenshots ≥ minimum count for platform | 3 for itch, 5 for Steam, 2 for Play |
| No leftover dev assets in `res://` | No `_test_`, `_old_`, `_temp_` files in the export paths |

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Ship debug builds to Steam | Use `--export-release` after capability proof | Debug builds leak paths and run slower |
| Use 256×256 icon for iOS | 1024×1024 (Apple downscales) | iOS rejects undersized icons |
| Skip Steam trailer | Record at least 30 sec gameplay before launch | Steam blocks the release without it |
| Ship APK to Play Store | Build AAB | Play requires AAB since 2021 |
| Skip code-signing on macOS / Windows | Get a cert; without it, users can't run the build | Gatekeeper / SmartScreen blocks unsigned binaries |
| Skip notarization on macOS | Notarize after signing | Quarantined apps can't run on most modern macOS |
| Ship without `LICENSE` | Add MIT or commercial license to repo root | Steam + itch + most platforms require it |
| Forget attribution for CC-BY assets | `attribution.md` listing each asset's source + license | Otherwise = takedown notice + ban |
| Auto-upload via skill | Produce builds; user uploads | Uploads have side effects (versioning, refunds, metadata changes) |
| Push 1.0.0 first | Push 0.9.0 internal first, then 1.0.0 to public | Internal testing catches the embarrassing-launch-day bugs |
| Same build for all stores | Per-store metadata + separate upload | Steam wants `.exe`, Play wants `.aab`, web wants `.html` |

## Anti-patterns

- **"Just enable all export options."** Encryption + JS eval + edit-time features bloat the binary. Disable what you don't use.
- **"I'll fix the icon later."** Apple and Google reject submissions with placeholder icons. They'll take a week to re-review.
- **Unsigned macOS builds outside Steam.** Apple Gatekeeper is strict. The user-facing workaround ("right-click → Open → confirm") is bad UX.
- **Embed PCK = false on desktop.** Splits the binary into multiple files; users delete the PCK by accident; bad first-run experience.
- **Trailer is a slideshow.** Steam's algorithm down-weights gameplay-less trailers. Show actual gameplay in the first 5 seconds.

## Collaborative protocol

This skill produces release artifacts. Always ask before each build is invoked. Group platforms — "I'm about to build Windows + Mac + Linux release configs into `build/`. OK?". See `../../references/collaborative-protocol/collaborative-protocol.md`.

## Want a working starter?

No template — this is a workflow. Each project's export config and store assets are project-specific. For the Steam-specific GodotSteam GDExtension setup, see `deployment/steam-uploader/SKILL.md` (when shipped).

## See also

- `../../references/mcp-tools-reference/mcp-tools-reference.md` — full MCP tool list
- `../../references/godot-version/godot-version.md` — Summer compatibility and
  export-template versioning
- `../../references/collaborative-protocol/collaborative-protocol.md` — "May I write" pattern
- `deployment/export-presets/SKILL.md` — preset config deep dive
- `deployment/web-html5-export/SKILL.md` — HTML5-specific traps
- `deployment/steam-uploader/SKILL.md` — `steamcmd` + GodotSteam (when shipped)
- `deployment/itch-uploader/SKILL.md` — `butler` workflow (when shipped)
- `deployment/mobile-export/SKILL.md` — iOS / Android specifics (when shipped)
- `asset-pipeline/attribution-and-licensing/SKILL.md` — community asset attribution
- `performance/tune-performance/SKILL.md` — pre-ship performance pass
