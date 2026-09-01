---
spec: eval/skill-spec/export-and-ship
skill: skill/export-and-ship
status: ported
source: tests/specs/export-and-ship.md
runner: manual   # /skill-test today; automated harness is a fast-follow (ROADMAP §3.4)
---

# Skill Spec: /export-and-ship

## Fixture

- Summer Engine project, complete game with main scene set, no script errors, basic icon at `icon.png` (256×256).
- Existing `export_presets.cfg` with Windows/Mac/Linux presets, all `debug = true` (development defaults).
- No `LICENSE` file at repo root.
- No `attribution.md`.
- Two CC-BY 4.0 assets imported from public sources (used in scene).
- Summer MCP tools available.

## Case 1: Happy Path — Steam (Windows + Mac + Linux)

**Input:** "I'm ready to ship to Steam. Build me Windows, Mac, and Linux releases."

**Expected MCP tool sequence (in order):**

1. (Skill asks the destination question and waits — confirms Steam, Win/Mac/Linux.)
2. Pre-flight:
   - `summer_get_diagnostics` — clean
   - `summer_get_console` — clean
   - Read `project.godot` — main scene set, no version, no name
   - Read `LICENSE` — does not exist
   - Read `attribution.md` — does not exist
   - Read `export_presets.cfg` — `debug = true` on all presets
   - Grep for hardcoded paths
3. (Skill lists the pre-flight failures: missing LICENSE, missing attribution.md, missing version, missing game name, debug=true on release presets, missing Steam-required assets like trailer + capsules.)
4. Skill asks: "Pre-flight failed on N items: <list>. Want me to walk these one by one?"
5. (Does NOT proceed to build.)

**Assertions:**

- [ ] Skill asks the destination question first.
- [ ] Skill runs the FULL pre-flight checklist before any build.
- [ ] Skill detects missing LICENSE and missing `attribution.md`.
- [ ] Skill detects `debug = true` and flags it as a blocker for release.
- [ ] Skill detects missing Steam-specific assets (capsules, trailer) and lists them.
- [ ] Skill does NOT produce a build until the user fixes the blockers OR explicitly waives them.
- [ ] Skill never auto-uploads to Steam Pipe — only points at the upload command.

## Case 2: Failure Path — pre-flight passes, but iOS targeted without Apple Developer setup

**Fixture:** Project is clean (LICENSE present, no script errors, version + name set).

**Input:** "Ship to iOS App Store."

**Expected behavior:**

- Skill runs pre-flight — clean.
- Skill walks iOS-specific requirements: 1024×1024 icon, screenshots at 6.5" iPhone resolution, App Store description, privacy policy URL, support URL, bundle ID, Apple Developer cert + provisioning profile.
- Skill asks: "iOS submission requires (a) Apple Developer account ($99/yr), (b) Bundle ID configured in Apple Developer portal, (c) distribution certificate + provisioning profile, (d) macOS machine with Xcode for the final archive step. Do you have these set up? If not, those are the prerequisites — I can help with the build config but not the Apple Developer side."
- Does NOT silently produce an unsigned `.ipa` that can't be submitted.

**Assertions:**

- [ ] Skill names the iOS prerequisites that aren't satisfiable from inside Godot.
- [ ] Skill names the bundle-ID convention (`com.<org>.<game>`).
- [ ] Skill mentions TestFlight before App Store review.
- [ ] Skill does NOT pretend to do code signing it can't actually do.
- [ ] Skill names AAB-vs-APK if the user mistakenly says "Android APK" (different ticket but related anti-pattern).

## Case 3: Edge Case — multi-platform, web HTML5 included

**Fixture:** Same as Case 1 but post-fix (LICENSE added, attribution.md added, presets `debug = false`, version = "1.0.0", screenshots ready, trailer recorded).

**Input:** "Ship to Steam + itch + web."

**Expected behavior:**

- Pre-flight clean.
- Skill walks each platform's requirements separately.
- For web: explicitly flags the multiplayer transport (ENet doesn't work in browser), the audio autoplay block (Chrome blocks until first user click), and the file-size matters trap.
- Web export preset configured: encryption disabled, no JS eval, GLES3 fallback to GLES2 on if old browsers targeted.
- Skill asks: "May I produce 5 builds (Win + Mac + Linux + itch packages + web)?"
- Produces builds via `godot --headless --export-release` invocations after user OK.
- Verifies each build size and lists post-build warnings (e.g. "Web build is 180 MB — consider stripping unused textures").
- Points at upload commands for each: `steamcmd`, `butler push`, manual itch web upload.

**Assertions:**

- [ ] Skill walks per-platform requirements separately, NOT a generic checklist.
- [ ] For web: skill flags the autoplay + multiplayer + file-size traps explicitly.
- [ ] Skill produces builds in correct order (build, then verify, then point at upload — never auto-upload).
- [ ] Skill provides per-platform upload commands (steamcmd / butler / etc).
- [ ] Skill does NOT execute uploads itself.

## Case 4: No Summer MCP — fallback path

**Fixture:** Same as Case 1, MCP unavailable.

**Input:** "I want to ship to Steam."

**Expected behavior:**

- Skill detects MCP unavailable.
- Asks user to confirm via the editor: main scene set, no errors in Output panel, no errors in Debugger panel.
- Asks user to paste contents of `project.godot` and `export_presets.cfg`.
- Walks the pre-flight checklist by reasoning over the pasted text.
- Provides per-platform asset list and config recommendations.
- Provides build commands the user can run manually (`godot --headless --export-release ...`).
- Provides upload commands the user can run manually (`steamcmd ...`).
- Still applies "May I write" before any file edit (e.g. `LICENSE` creation).

**Assertions:**

- [ ] Skill does not blindly call `summer_*` tools and fail.
- [ ] Skill asks for the specific files it needs (project.godot, export_presets.cfg).
- [ ] Skill still runs the full pre-flight check via reading.
- [ ] Skill names the same blockers (LICENSE, debug=true, missing trailer).
- [ ] Skill asks "May I write" before creating LICENSE / attribution.md / etc.

---

This spec runs via `/skill-test export-and-ship spec` (see `workflow/skill-test/SKILL.md`).
