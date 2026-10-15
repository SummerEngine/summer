---
name: voice-and-mic-permissions
description: "Use the microphone in a Summer game the safe way: declare it, ask only from a talk tap, keep a text path, never touch OS permissions."
license: MIT
compatibility: [Cursor, Claude Code, Windsurf, Codex]
category: audio
user-invocable: true
allowed-tools: Read Grep Glob Edit Write summer_project_setting summer_add_node summer_set_prop summer_inspect_node summer_connect_signal summer_get_script_errors summer_get_diagnostics summer_get_console summer_play summer_game_input summer_stop
paths: ["**/*.gd", "**/*.tscn", "project.godot", "export_presets.cfg", "ai/characters/*.json"]
---

# /voice-and-mic-permissions — Use the Microphone Without Breaking It

## Overview

Every operating system shows its microphone prompt once. If a player says no to that prompt, only a trip to system
Settings can undo it. Most players never make that trip, so a badly timed ask kills voice for that player for good.

Summer owns the ask. The SDK shows Summer's one-line primer, then the OS or browser prompt, and remembers each
player's answer per game. Your game code does four things and nothing more:

1. Declare that the game uses the microphone.
2. Start the ask from the player's tap on a talk or mic control.
3. Keep a text (or button) path that reaches the same content.
4. Show the state Summer reports. Never ask the OS yourself.

**Core principle:** the player's tap on Talk is the only moment Summer may ask. Everything else is the text path.

**Second principle:** voice output never needs the mic. When the player types, the character still speaks.

**Status: preview.** `Summer.client.mic` and the gated capture ship with the Summer Engine release that carries
Summer Router voice. Names follow the Summer microphone contract; if the engine reports a different signature, the
engine's class reference wins.

## When to use

- A talking character: `SummerRouterCharacter` in voice mode, or `Summer.client.router.talk(..., {"mode": "voice"})`.
- Voice commands ("hit", "kick", "jump"), shout or sing mechanics, a mic level meter.
- Any `AudioStreamMicrophone` or `AudioEffectCapture` use.

## When NOT to use

- Character speech output only (text-to-speech lines) → `voice-line`. No mic needed.
- Pre-recorded voice files → import them; no mic needed.
- Player-to-player voice chat → not covered here.

## Steps

### 1. Pick the kind of mic use

| You want | Use |
| --- | --- |
| A character the player talks to | `SummerRouterCharacter` (it runs the whole mic flow) |
| Your own talk session code | `Summer.client.router.talk()` + `push_to_talk()` |
| Raw audio (voice commands, meter, shout) | `Summer.client.mic.request_access()` + `AudioStreamMicrophone` |

### 2. Declare the microphone

Add `microphone` to the store listing's `features`. Without it:

- `Summer.client.mic.get_access()` returns `undeclared`.
- On summer.games the game frame never gets the mic.
- In the Summer Games apps the engine refuses capture.

Set it on the game's store page in Studio, then publish the page. Until the listing editor shows a "Uses the
microphone" option, ask the game's owner to add it.

### 3. Set the project setting

```
summer_project_setting(key="audio/driver/enable_input", value=true)
```

Do not change `audio/general/ios/session_category`. Summer switches the audio session only while a voice session
runs, then switches it back.

### 4. A talking character (preferred)

```gdscript
extends Node3D

@onready var guard: SummerRouterCharacter = $Guard
@onready var talk_button: Button = $HUD/TalkButton
@onready var chat_box: LineEdit = $HUD/ChatBox

func _ready() -> void:
	# Read the state to draw the button. Never ask here.
	_show_mic(Summer.client.mic.get_access())
	Summer.client.mic.access_changed.connect(_show_mic)

	# Push-to-talk. The first press runs Summer's primer and the OS prompt if needed.
	talk_button.button_down.connect(func(): guard.push_to_talk(true))
	talk_button.button_up.connect(func(): guard.push_to_talk(false))

	# The text path always works, in every state.
	chat_box.text_submitted.connect(_on_text_submitted)
	guard.mode_changed.connect(_on_mode_changed)

func _on_text_submitted(text: String) -> void:
	if text.strip_edges().is_empty():
		return
	guard.say(text)
	chat_box.clear()

func _on_mode_changed(mode: String, _reason: StringName) -> void:
	# After a no the session is in text mode. The guard still answers out loud.
	if mode == "text":
		chat_box.grab_focus()

func _show_mic(access: StringName) -> void:
	# Only the look changes. Summer shows every card and dialog itself.
	talk_button.modulate.a = 1.0 if access == &"granted" or access == &"not_requested" else 0.6
	talk_button.visible = access != &"undeclared" and access != &"unavailable"
```

`SummerRouterCharacter` with its built-in talk button does all of the above without this script.

### 5. Raw mic capture (voice commands, meters)

Put the mic player on its own muted bus. Bus effects run before the mute, so the capture effect still gets the
audio, and the player does not hear themself.

```gdscript
extends Node

const MIC_BUS := "Mic"

@onready var mic_player: AudioStreamPlayer = $MicPlayer
@onready var mic_button: Button = $HUD/MicButton
var capture: AudioEffectCapture

func _ready() -> void:
	var bus := AudioServer.get_bus_index(MIC_BUS)
	if bus == -1:
		AudioServer.add_bus()
		bus = AudioServer.bus_count - 1
		AudioServer.set_bus_name(bus, MIC_BUS)
		AudioServer.add_bus_effect(bus, AudioEffectCapture.new())
	AudioServer.set_bus_mute(bus, true)
	capture = AudioServer.get_bus_effect(bus, 0) as AudioEffectCapture
	mic_player.bus = MIC_BUS
	mic_button.pressed.connect(_on_mic_button_pressed)

func _on_mic_button_pressed() -> void:
	# Called from the press, so Summer may ask now.
	var r := await Summer.client.mic.request_access()
	if not r.ok:
		_use_buttons_instead()   # the game keeps working
		return
	mic_player.stream = AudioStreamMicrophone.new()
	mic_player.play()

func _process(_delta: float) -> void:
	if capture == null or not mic_player.playing:
		return
	var peak := 0.0
	for frame in capture.get_buffer(capture.get_frames_available()):
		peak = maxf(peak, maxf(absf(frame.x), absf(frame.y)))
	$HUD/MicMeter.value = peak   # or feed the frames to your recognizer

func _use_buttons_instead() -> void:
	$HUD/CommandButtons.visible = true
```

### 6. Keep a text or button path

- Every voice line the player can say has a typed or button equivalent that reaches the same result.
- Every voice command has a button or key.
- Never lock progress, rewards or content behind the microphone. App Store and Google Play reject that.

### 7. Show the state, nothing more

| `get_access()` | What your UI shows | What Summer does on a talk tap |
| --- | --- | --- |
| `granted` | Normal talk button | Starts listening |
| `not_requested` | Normal talk button | Shows the primer, then the OS prompt if needed |
| `declined` | Mic-off talk button + text box | Shows a one-tap "Use mic" card |
| `blocked` | Mic-off talk button + text box | Shows the Settings card (only on this later tap) |
| `undeclared` | Hide voice | Nothing. Fix step 2. |
| `unavailable` | Hide voice, keep text | Nothing (no mic, busy, or no Host) |

### 8. Exports (Steam, itch, own site)

| Target | Set in `export_presets.cfg` |
| --- | --- |
| iOS | `privacy/microphone_usage_description` (and `privacy/microphone_usage_description_localized`) |
| macOS | `privacy/microphone_usage_description`, `codesign/entitlements/audio_input = true`, hardened runtime, Developer ID signing |
| Android | `permissions/record_audio = true` |
| Windows | Nothing. Code-sign the `.exe`. |
| Web | Serve over HTTPS. A site that frames the game needs `allow="microphone"` on its iframe. |

Write the usage description as one specific sentence with an example: "Talk to the guard with your voice while you
hold Talk." Not "Microphone access is needed."

Summer Router calls need the Summer Host, so they return `unavailable` in exported builds. Raw mic capture still works.

## Never do this

- **Never call `OS.request_permission()` or `OS.request_permissions()`.** The Summer sandbox blocks them and logs a
  violation. Summer asks for you.
- **Never ask from `_ready()`, `_enter_tree()`, a timer, a cutscene end or a level load.** `request_access()` returns
  `mic_needs_player_action` there and shows nothing.
- **Never play an `AudioStreamMicrophone` before `request_access()` returns `ok`.** The engine refuses capture and
  logs a teach line.
- **Never draw your own "allow the mic?" dialog**, and never copy the look of a system dialog.
- **Never tell the player to open Settings, and never show a message right after a denial.** Summer offers Settings
  only when the player taps talk again.
- **Never loop or retry the ask.** One tap, one ask.
- **Never reward the player for saying yes or punish a no.**
- **Never put the mic player on an unmuted bus.** The player hears themself and the character hears the echo.
- **Never set the iOS session category to Play and Record for the whole game.** It routes game audio to the earpiece
  and stops other apps' audio.
- **Never call `getUserMedia` through `JavaScriptBridge` on the web.** It skips Summer's flow, and the frame has no
  mic anyway unless Summer gave it one.
- **Never decide "no permission" from silence yourself.** Summer emits `mic_quiet` when it hears only digital
  silence.

## How to test

1. Static checks: `summer_get_script_errors`, then `grep -rn "request_permission\|getUserMedia" --include=*.gd .`
   must find nothing.
2. Launch with `summer_play` and play for a minute without pressing talk. `summer_get_diagnostics` must show no
   microphone prompt and no capture.
3. Every branch without a real mic (preview flag; the name may change): run with
   `--summer-mic-fake=granted`, `not_determined`, `denied`, `restricted`, `silent` and `no_device`. For each one,
   press talk with `summer_game_input` and check that the text path works.
4. Real device, once per platform you ship:
   - Fresh install, play without pressing talk: no prompt.
   - Press talk: Summer's primer, then the OS prompt.
   - Say no to the OS: the game switches to text with no dialog.
   - Press talk again: Summer's Settings card appears.
5. Reset between runs:
   - iOS: Settings > General > Transfer or Reset > Reset > Reset Location & Privacy.
   - macOS: `tccutil reset Microphone <bundle id>`.
   - Android: `adb shell pm revoke <package> android.permission.RECORD_AUDIO` and
     `adb shell pm clear-permission-flags <package> android.permission.RECORD_AUDIO user-set user-fixed`.
   - Browser: clear the site's permissions for summer.games.

An AI voice session on a laptop or phone speaker can hear its own character. Test with speakers, not only
headphones. Use push-to-talk (`turn.mode: push_to_talk` in the character file) if the character interrupts itself.

## Edge cases

- **The player said yes in game A.** Game B still shows Summer's primer once. The OS prompt does not show again.
- **"Only this time" on Android.** The grant ends after the game sits in the background. The next talk shows the OS
  prompt again. Summer handles it; your code does nothing.
- **iPad cover closed, phone call, no mic plugged in.** `request_access()` returns `ok: false` with `unavailable` or
  `blocked`. Use the text path.
- **The player turns the mic off in iOS Settings.** iOS ends the app. On relaunch `get_access()` returns `blocked`.
- **Web.** On summer.games the browser asks for "summer.games", not for your game. That is expected.

## Fallback (no MCP)

Edit the scripts and `project.godot` by hand with the code above. Ask the user to add `microphone` to the listing
features in Studio.

## Handoff

> Voice is wired: `Guard` listens on push-to-talk, the text box works in every state, and the game never asks at
> launch. Next:
> - Add `microphone` to the listing features before publishing.
> - Test once on a real phone with the speaker on.

## See also

- `voice-line`: character speech output.
- `summer-router`: talking characters, tools and the summer router CLI.
- `design-npc`: the character's behavior around the conversation.
- `export-and-ship`: export presets per platform.
