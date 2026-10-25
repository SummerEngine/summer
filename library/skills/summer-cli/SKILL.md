---
name: summer-cli
description: "Summer as shell commands, no MCP: sign in, run operations, follow jobs, save files, drive the engine."
license: MIT
compatibility: [Cursor, Claude Code, Codex, Windsurf, Gemini, OpenCode, Factory, Copilot]
category: _meta
allowed-tools: Bash Read
---

# Summer from the shell

Use this skill when the session has no `summer_*` MCP tools (Summer was set up with `summer setup <agent> --cli`), or when a script or CI job runs Summer. Every Summer capability is an operation named `area.action`, and every operation is one command: `summer <area> <action>`. The commands run the same code as the MCP tools and give the same answers.

First run `summer --version`. If the shell does not find `summer`, or the version is below 4.0 (an old global install, which has no `summer <area> <action>` commands), put `npx -y summer-engine@latest` in place of `summer`, with the same arguments. In Windows PowerShell, write `npx.cmd`.

## The five commands in a game project

<!-- project-commands: the AGENTS.md that summer create and summer setup write copies this list -->
1. `summer run .` opens the project in Summer Engine. An agent's run stays in the background.
2. `summer engine get-project-context` (MCP: `summer_get_project_context`) reads the project, its main scene and the engine version. Run it first.
3. `summer engine play`, then `summer engine get-diagnostics` (MCP: `summer_play`, `summer_get_diagnostics`), runs the game and reads its errors. `summer engine stop` (`summer_stop`) ends it.
4. `summer engine screenshot` (MCP: `summer_screenshot`) saves an image of the editor or the running game. Open its `localPath` to look.
5. `summer ops search "<what you want>"` (MCP: `summer_search`) finds any other operation. Run it as `summer <area> <action>` (MCP: `summer_call`), with `--dry-run` first for a change.
<!-- /project-commands -->

## 1. Sign in once

```bash
summer login     # opens the browser: the Summer account, then the store and cloud operations
summer whoami    # who is signed in, and their credits
```

Cloud operations (generation, the asset library, the store, publishing, analytics) need the sign-in. Engine commands do not. Run `summer login` in the foreground, once. Tell the person that their browser opens, and wait for them.

## 2. Find the operation

```bash
summer ops search "make a sound effect"       # the best matches: name, effect, title
summer ops describe assets.generate_audio     # the exact input: fields, types, which are required
```

Describe the job in plain words. `--area assets` keeps one area. Without a sign-in, search and describe still find every operation: a cloud one shows `(needs sign-in)` and runs after `summer login`.

For a guide instead of an operation, search the library: `summer docs search --query "<the task>"`, then `summer docs read --id <id>`. Both work offline. Then follow the skill it names.

Each Summer skill ends with a **From a shell** table: the command for each MCP tool and operation the skill names. A skill that says `summer_play` or `assets.generate_image` means `summer engine play` or `summer assets generate-image`.

## 3. Run it

```bash
summer assets generate-image --dry-run --prompt "a cozy pixel-art tavern" --aspect-ratio 16:9
summer engine set-prop --scene-path res://main.tscn --path Player --key position --value "Vector3(0, 1, 0)"
summer store status --game-id <id> --json
```

- Actions and fields are kebab-case: `aspectRatio` is `--aspect-ratio`, `look_at` is `--look-at`.
- `--<field>` alone sets a boolean field to true; `--no-<field>` sets it to false. Repeat a flag to give a list.
- Objects, and anything hard to quote, go in `--input '<json>'`. A flag wins over the same key in `--input`.
- `--dry-run` checks the input and changes nothing. For a spend it shows the estimate in credits. Put it right after the action: after `summer setup <agent> --cli --allow-rules --yes` (run that only when the person asks for it), Claude Code and Codex run it without asking (and the reads). Before each generation or other spend: dry-run it, tell the person what you will make, and wait for a yes.
- `--idempotency-key <key>` makes a retry safe: Summer runs a change once per key.
- `--json` prints only the answer: `{"ok":true,"status":"done","result":{...}}`. The exit code is 0 for every `ok` answer and 1 for an error.

## 4. Long jobs

3D, video, animation, builds and uploads answer `Started: job <id>` with the command that follows the job.

```bash
summer assets generate-3d --prompt "a wooden barrel" --wait          # runs, then follows the job to the end
summer jobs wait --job-id <id> --timeout-seconds 50                  # run it again until finished is true
```

Do not run the same change again to get its result. Wait on the job.

## 5. Approvals

A publish or another live change can answer `Needs approval` with a link. Give the person that link: nothing changes until they approve. Follow it with `summer jobs wait --job-id <id>` (or `--wait` on the call) until it ends: `done`, `declined`, `expired` or `stale`. Never approve for the person.

## 6. Files

- `--out <folder or file>` on a generate command, on `summer jobs wait` or on `summer assets get` saves the file there. In a Godot project, `res://` paths work. The answer adds `localPath`.
- Without `--out`, a generation run inside a game project saves into its asset folder: Godot `assets/`, Unity `Assets/Summer`, Unreal `Content/Summer`, three.js `public/assets`. Outside a project, give `--out`.
- `summer assets get --asset-id <id>` saves only with `--out`.
- A save never overwrites a file. Tell the person the `localPath`.

## 7. The engine

Engine commands (`summer engine …`) drive the Summer Engine app on this machine. The app must run with the project open.

```bash
summer status                                              # is the engine up, and the sign-in
summer run ./my-game                                       # opens the project; for an agent, in the background
summer engine get-project-context                          # first call: project, main scene, engine version
summer engine get-scene-tree --scene-path res://main.tscn --depth 2
summer engine screenshot                                   # the answer's localPath is an image: open it to look
summer preview                                             # the game, live, in your own browser: http://127.0.0.1:5199
```

- Values are engine value strings, not JSON: `"Vector3(0, 10, 0)"`, `"Color(1, 0.5, 0, 1)"`. A resource is its class name: `"BoxMesh"`.
- Name the scene in every change: `--scene-path res://<scene>.tscn`.
- 3 or more scene edits are one script, not a chain of commands. Write a `func run(ctx):` that ends with `ctx.save_scene()` to a file, then run `summer engine run-script --scene-path res://main.tscn --source "$(cat build.gd)"`. The `scene-scripting` skill has the script API.
- With more than one editor open, set `SUMMER_ENGINE_PROJECT` to the project folder so the command picks the right one.
- To watch the game in your own browser (Claude Code Desktop's Browser pane, the Codex app's in-app browser), run `summer preview` in the background, from the folder the session started in. It serves http://127.0.0.1:5199 (the next free port if that one is taken; it prints the URL): the running game, or the editor view when no game runs, with a status line that says what to do next. It also adds a `summer-preview` entry to `.claude/launch.json` there, so Desktop starts it and checks the game after each edit. A game frame comes about every 20 s, because reading one stalls the game; the page's Refresh button takes one now. Keys and clicks on the frame go to the running game. `--no-launch-json` leaves the file alone.
- `summer tool <slug> --args '<json>'` runs an engine tool by its 3.x name too. `summer tool --list` lists them.

## Without Summer Engine

Everything except section 7 works without the app: the sign-in, the library, generation, assets and files, the store and analytics. Skip the `summer engine …` commands; there they answer `engine_not_running`. For assets for another engine or a web app, follow the `summer-assets` skill and stop at the file.

## 8. Errors

An error prints `Error (<code>): <message>` and one `Next:` step, and exits 1. Do the next step. Retry only when the table says so.

| Code | Do this |
|---|---|
| `not_signed_in` | Run the command in `Next` (`summer login`), then the same command again. |
| `engine_not_running` | Open the project in Summer Engine, or `summer run <project-path>`. Then run it again. |
| `engine_lacks_op` | This engine build is too old for the command. Use the fallback the message names, or ask the person to update Summer Engine. |
| `invalid_input` | `summer ops describe <op>`, fix the flags, run it again. |
| `no_credits` | Give the person the link in `Next`. Do not run it again until they say they added credits. |
| `forbidden` | Summer refused this account. The person checks it in Summer Studio. |
| `not_found` | Check the id (the area's `list` command), or find the right operation with `summer ops search`. |
| `rate_limited`, `unavailable` | Nothing ran. Wait a minute and run it again. If it repeats, tell the person the message. |
| `outcome_unknown` | The change may have run. Run it again only with the same `--idempotency-key`, or check first. |
| `in_progress` | The same change is still running. Wait, then follow its job or run it again with the same `--idempotency-key`. |
| `idempotency_conflict` | That key was used for a different input. A new change needs a new key. |
| `conflict` | The state changed, or a job or approval ended without running (declined, expired, stale or cancelled). Check the current state; start again only if the person wants it. |
| `over_limit` | A plan limit or cap was reached. Give the person the message and the link in `Next`. Do not retry. |
| `unsupported` | Summer cannot do this yet, or not here. Tell the person the message. Do not retry. |
| `internal` | Summer failed on its side. Run it once more; if it fails again, tell the person the message. |

## Done means

- You ran each command and read its answer. Do not report an answer you did not get.
- Every spend had a dry run and a yes from the person first.
- Every file you made is saved, and you told the person its `localPath`.
