---
name: export-and-ship
description: Use when the user is ready to export a build for distribution to Steam, itch.io, web (HTML5), iOS, Android, or any combination. Validates icons, store banners, screenshots, build config, and runs a pre-flight checklist before producing a release build. Trigger on "export", "ship", "release", "build", "Steam", "itch", "HTML5", "iOS", "Android", "submit", "publish".
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: deployment
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_get_scene_tree summer_inspect_node summer_project_setting summer_get_console summer_get_diagnostics
paths: ["**/*.gd", "**/*.tscn", "project.godot", "export_presets.cfg", "**/*.png", "**/*.svg", "**/*.icns", "**/*.ico"]
---

# /export-and-ship — Export and Prep Distribution

## Overview

Shipping is a checklist, not a creative act. This skill walks the platform-specific asset and config requirements, runs a pre-flight check against the project, and produces a release build only after every blocker is green. Better to fail at this step than fail submission.

**Core principle:** every platform has a list. Read the list, satisfy the list, ship.

## Steps

### 1. Pick the destination(s)

Open with the question. Multi-select.

> Where to? Pick all that apply: **Steam** / **itch.io** / **web (HTML5)** / **iOS App Store** / **Google Play** / **macOS DMG** / **Windows installer** / **other**.

Each destination has a different list. Multiple destinations = multiple lists. Don't shortcut — the iOS list does not satisfy the Steam list.

### 2. Run the pre-flight checklist

Always do this first, regardless of destination.

**Preferred (Summer MCP):**

```
summer_get_diagnostics            # any errors? if yes, abort.
summer_get_console                # any "import failed" warnings?
summer_get_scene_tree             # is the main scene set?
```

**Fallback (no MCP):** ask the user to confirm via the Godot editor: Project → Project Settings → Application → Run → Main Scene is set; no errors in Output panel.

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

### 3. Per-platform asset requirements

Walk the list for each chosen destination. Each is non-negotiable.

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

- Export preset: **Windows Desktop** (x86_64) + **Linux** (x86_64) + **macOS** (universal). Steam requires all three for max reach; 99% of Steam revenue is Windows but Linux/macOS doesn't hurt.
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
- Export preset: Windows + macOS + Linux; package as ZIP.
- Or use `butler push` (itch's CLI) for atomic versioning and patches.
- Web build (HTML5) is free real estate on itch — also do it.

#### c) Web (HTML5)

Browser export. Constraints:

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

### 4. Build config consistency check

Before producing builds, verify `export_presets.cfg` for each target:

```
Read export_presets.cfg
```

For each preset:

| Field | Production value | Why |
|---|---|---|
| `binary_format/embed_pck` | `true` | Single EXE per platform |
| `debug` | `false` | Debug builds leak source paths and run slower |
| `texture_format/etc2_astc` | `true` for mobile | Smaller texture compression |
| `application/short_version` | matches `application/config/version` | Steam reads it |
| `script/encryption_key` | set if you don't want PCK extracted | Optional but recommended for paid games |
| `application/icon` | path to your `.ico` / `.icns` / `.png` | Otherwise generic Godot icon ships |

### 5. Propose the build sequence

> Pre-flight: clean. Targets confirmed: Steam (Win + Mac + Linux) + itch (same builds) + web. Required assets: I see all icons + 5 screenshots in `marketing/`. Missing: trailer (Steam blocks Coming Soon → Released without one). May I produce the builds now and flag the trailer as a follow-up?

### 6. Produce the builds

Godot's CLI export is the standard scripted path:

```
godot --headless --export-release "Windows Desktop" build/win/MyGame.exe
godot --headless --export-release "Linux" build/linux/MyGame.x86_64
godot --headless --export-release "macOS" build/mac/MyGame.app
godot --headless --export-release "Web" build/web/index.html
godot --headless --export-release "Android" build/android/MyGame.aab
godot --headless --export-release "iOS" build/ios/MyGame.xcodeproj
```

For Summer Engine: replace `godot` with `summer` (or the local binary path). Same flags.

If the user is on a CI system (GitHub Actions etc), this is the right place to point them at a cross-compile workflow — Godot can export Windows + Linux from a Linux runner.

### 7. Verify each build

For each build:
- Launch it. Confirm the title screen renders.
- Run for 30 seconds. Confirm no console errors.
- Check the file size (anything over 500 MB needs justification — usually unstripped textures or unused assets).
- For mobile: install on a real device, not just the emulator.

### 8. Submit / upload

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
| Export preset `debug = false` | For all release presets |
| Export preset `embed_pck = true` | For all desktop release presets |
| `.gitignore` excludes build artifacts | `build/`, `.godot/`, `.import/`, `*.tmp` listed |
| Screenshots ≥ minimum count for platform | 3 for itch, 5 for Steam, 2 for Play |
| No leftover dev assets in `res://` | No `_test_`, `_old_`, `_temp_` files in the export paths |

## Common mistakes

| Don't | Do | Why |
|---|---|---|
| Ship debug builds to Steam | `debug = false` in release export preset | Slower, leaks paths, larger |
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

This skill produces release artifacts. Always ask before each build is invoked. Group platforms — "I'm about to build Windows + Mac + Linux release configs into `build/`. OK?". See `_shared/collaborative-protocol.md`.

## Want a working starter?

No template — this is a workflow. Each project's export config and store assets are project-specific. For the Steam-specific GodotSteam GDExtension setup, see `deployment/steam-uploader/SKILL.md` (when shipped).

## See also

- `_shared/mcp-tools-reference.md` — full MCP tool list
- `_shared/godot-version.md` — Godot 4.5 export-template versioning
- `_shared/collaborative-protocol.md` — "May I write" pattern
- `deployment/export-presets/SKILL.md` — preset config deep dive
- `deployment/web-html5-export/SKILL.md` — HTML5-specific traps
- `deployment/steam-uploader/SKILL.md` — `steamcmd` + GodotSteam (when shipped)
- `deployment/itch-uploader/SKILL.md` — `butler` workflow (when shipped)
- `deployment/mobile-export/SKILL.md` — iOS / Android specifics (when shipped)
- `asset-pipeline/attribution-and-licensing/SKILL.md` — community asset attribution
- `performance/tune-performance/SKILL.md` — pre-ship performance pass
