# MITL — model-in-the-loop eval

The one test the other families skip: a **real model** (Claude Code, headless `claude -p`)
drives **this checkout's MCP server** (`node dist/bin/summer.js mcp`) against a **real Summer
Engine editor** on a **pristine template project**, doing what a hackathon user would type.
The scorer is the same autopilot probe the template ships (`tests/autopilot/run.sh`) plus one or
two task checks. No mocks, no replay: every number in `results/` came from a model choosing tools.

```
npm run build                       # the server under test is dist/, not npm
claude setup-token                  # once; prints a long-lived OAuth token (opens a browser)
export CLAUDE_CODE_OAUTH_TOKEN=…    # the fake HOME has no login of its own
MITL_ALLOW_ENGINE=1 bash evals/mitl/run.sh all          # 8 tasks × (create + 2 smokes + editor + model), sequential
MITL_ALLOW_ENGINE=1 bash evals/mitl/run.sh fps-sprint-stamina
```

`MITL_ALLOW_ENGINE=1` is the explicit go-ahead for engine processes on this machine; without it
every task stops at `gate_refused` before the first launch (create still runs). `run.sh --help` lists
the other knobs (`MITL_SCRATCH`, `MITL_RESULTS`, `MITL_MODEL`, `MITL_MCP_ONLY`, `MITL_AGENT_TIMEOUT_S`,
`MITL_KEEP_PROJECT`, `MITL_GATE_MAX_S`, `MITL_ENGINE_BIN` — path to the editor executable inside a bundle,
e.g. a posture-fixed dev build; each task json records the binary, its `/api/health` version and
`capabilities.launchPostures`, with a note saying "silent launch" when `offscreen` is advertised and
"this engine will take focus on launch" when it is not). Run it as a background job you can `kill -TERM`:
the INT/TERM trap stops our editor, an in-flight smoke and every engine process descending from the
runner (parent-chain walk), then exits.

## What one task does

1. `summer create <template> <scratch>/projects/<task> --keep-git` — pristine, pinned, digest-verified.
   The checkout's `assets/autopilot/*` is copied over the scaffold so the probe is this build's.
2. **Baseline smoke**: `HOME=<fake> bash tests/autopilot/run.sh` (import pre-pass + offscreen verify
   run). Must PASS; otherwise the task is recorded as `baseline_failed` and skipped — a broken template
   is a template finding, not a model finding.
3. Editor launched **by the runner** with `HOME=<fake>`, `--editor --path <project> --summer-offscreen
   --summer-no-publish --disable-crash-handler`; wait for its `<fake>/.summer/instances/<id>.json` +
   `/api/health`. Five
   seconds later the project state is committed (`mitl: state after editor open`) so the engine's
   first-open rewrite (features bump, `uid=`/`unique_id=` on every node, `.bak`) is not scored as the
   model's work; `changed_files` additionally drops `.tscn` diffs that are pure uid bookkeeping.
4. `claude -p "<prompt>"` in the project dir with `HOME=<scratch>/mitl-home`, `--output-format stream-json`,
   `--mcp-config <task>/mcp.json --strict-mcp-config` (only this build's server, bound with
   `mcp --project <project>`), `--allowedTools "mcp__summer-engine__*" --permission-prompts none`,
   `--max-turns <task.max_turns>`, `--no-session-persistence`. Default mode keeps Claude Code's built-in
   tools with `--permission-mode acceptEdits` (Read/Edit/Write allowed in the project, Bash denied and
   counted in `permission_denials`); `MITL_MCP_ONLY=1` gives the model nothing but the MCP tools
   (`--tools ""`). A one-line system-prompt suffix asks for a final `STATUS: done|partial|blocked`
   line so `agent_claimed_done` is parsed, not guessed.
5. **Task checks** from `tasks.yaml`, while the editor is still up (live `get-scene-tree` and
   `run-editor-script` go through `summer tool …`, i.e. the same implementations as the MCP face).
6. Editor stopped (our pid only), pristine probe restored (if the model edited `tests/autopilot/*`
   it is noted), **post-change smoke**. `playable` = that smoke PASSED.
7. `results/<date>/<task>.json` + one row in `summary.tsv`; the per-task folder keeps
   `transcript.jsonl` (every tool call and result), `claude.args.json`, `editor.log`, `baseline.log`,
   `smoke_after.log`, `checks.json`, `agent.diff` (what the model changed, engine noise excluded),
   `git-status.txt`. The project is deleted unless `MITL_KEEP_PROJECT=1`.

Scores per task: `playable`, `checks_passed n/m`, `tool_calls` (total / MCP / built-in, by name),
`tool_errors` (+ up to 12 samples with the tool, its input and the error text),
`engine_lacks_op_count`, `turns`, `tokens_in/out` (+ cache read/create), `wall_s`,
`claimed_status`, `permission_denials`, `mcp_servers` status from the handshake.

## What it measures — and what it does not

- It measures whether **the toolkit lets a competent model finish a reasonable task** on a real
  engine: did the tools it reached for exist, do what their descriptions say, return errors it could
  act on, and leave a project that still boots without errors.
- `playable` means the autopilot **smoke** passed: the game booted offscreen, ran 60 physics frames,
  saved two frames and the engine logged **no ERROR / SCRIPT ERROR**. It does **not** mean the feature
  works, is visible, or is fun. A no-op change is "playable".
- The task checks are **static-ish proxies** (a regex in a script, a node in a scene, an editor script
  that inspects the saved scene). They catch "nothing was built" reliably and "the wrong thing was
  built" only sometimes. A failed check with a plausible `agent.diff` is a prompt to read the
  transcript, not a verdict.
- **No human judgment** of fun, feel, art or code quality. **No** measurement of the interactive
  Claude Code UX (permission prompts, skill picking by a human). One run per task: variance is
  unmeasured — do not read a single pass/fail as a rate.
- The prompts named in the brief for 2d-platformer, 3d-third-person-controller and
  2d-brario-platformer asked for features those templates already ship; `tasks.yaml` says what was
  substituted and why.

## Screen and HOME rules (non-negotiable on Mathias's Mac)

- **Nothing opens a visible window.** The editor is launched with `--summer-offscreen`; `summer run`
  is never used (it opens a visible editor). The verify run is the engine's own offscreen instance;
  the import pre-pass is `--headless`.
- **Gate before every engine launch**: `pgrep -fl 'Summer.app/Contents/MacOS/Summer'` must be empty
  for 10 consecutive seconds (other headless batches share this machine). The runner waits up to
  `MITL_GATE_MAX_S` and **never kills a process it did not start**. It kills only its own editor pid,
  then confirms it is gone; a stale `~/.summer/instances` entry is removed only if it names our dead pid.
  Note: the scaffold's `run.sh` performs two launches (import, verify) behind one gate.
- **HOME isolation — everything, engine included**: `claude`, the MCP server, `summer tool`, the
  editor, the import pre-pass and the verify run all run with `HOME=<scratch>/mitl-home`, set up once
  by `summer setup claude-code --local-dev --yes` under that HOME (skills, `~/.claude.json` MCP entry →
  this checkout). Why the engine too: on boot the editor restores the machine-wide desktop sign-in
  (native session JWT in the user's data dir + the shared WKWebView cookie store) and plants the real
  `se_session` cookie into its Studio webview — an editor launched with the real HOME would run
  production Studio as Mathias. `NSHomeDirectory` honours `$HOME`, so Application Support, WebKit,
  HTTPStorages and `~/.summer` all land under the fake HOME: a cold machine. The instance file the
  toolkit needs therefore appears in the fake `~/.summer/instances/` directly (no copy step);
  `--summer-no-publish` additionally stops the global `api-token`/`api-port` from being written.
  Mathias's real `~/.claude`, `~/.claude.json` and `~/.summer` are never written by the runner.
- **Isolation audit** (`<task>/isolation.txt`, also in the task notes): `editor.log` must not mention
  `se_session`; the fake HOME must contain no `se_session` / JWT-looking material (verified engine-free
  right after setup: none); the real `~/.summer` must have gained no files since the task started
  (files other processes touched there are listed, not judged).
- **Auth**: the fake HOME has no Claude login (keychain credentials are keyed to the real config dir).
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` is the supported hand-off; without it the model
  step records `auth_missing` and the rest of the pipeline still runs, so the harness is testable.

## Adding a task

One entry in `tasks.yaml`: `id`, `template` (a `library/templates/<slug>`), `prompt` (what a user
would type — no tool names), `max_turns`, `checks` (types documented at the top of the file). Make
sure every check **fails on the pristine template** (`node evals/mitl/lib/mitl.mjs checks <id>
<pristine-project> <fakeHome> /tmp/out` works engine-free for `file_regex`, disk `scene_node` and
`changed_files`) — an eval that cannot fail is documentation.
