# integrations/ — the complete, honest map of agent support

One folder per supported client. This directory is the single place that
says which agents Summer supports and how each one consumes the library.
Adding a new agent (e.g. Grok) = one folder here (plus, if it has a manifest
file, a builder in `scripts/generate-registry/manifests.ts` and a target in
`scripts/generate-registry/targets.ts`) + `npm run generate:registry` —
never hand-editing root files.

Each folder contains:

- `README.md` — what gets generated where, or (for clients with no manifest
  file in this repo) exactly what `summer setup <client>` writes at install
  time: MCP config path and skills destination.

`summer setup <client>` (default `--scope user`) writes the MCP config AND
installs every skill (`skills install --all`, preview included; `--stable-only`
skips preview) in the SAME scope,
so a user-scope MCP config never ends up beside project-scope skills.
`--scope project` moves both; `--recommended` installs only the recommended
subset. Clients whose MCP config is user-only (cline, roo-code, lm-studio,
gemini) fall back to user scope with a warning. `.mcp.json` at the repo root
(the MCP pointer the claude / codex / cursor / factory manifests share) is
generated too — `registry/generated/mcp.json -> .mcp.json`.
- `manifest-target.json` — mapping of generated file -> repo-root destination
  (empty when nothing is generated). Mirrors
  `scripts/generate-registry/targets.ts`; a test fails if they drift.

Generated root dot-files (`.claude-plugin/plugin.json`, `gemini-extension.json`,
…) are build artifacts of `integrations/<agent>` + `library/` — their
`_generated` banner says so ("GENERATED from integrations/<agent> — do not
edit; npm run generate:registry"). CI `--check` fails on any drift between
`library/`, `registry/generated/`, and the applied root files.

How the plugin manifests reference skills, and what is verified:

- **Claude Code** — the plugin-manifest `skills` field accepts a string or an
  array of `./`-relative directory paths and *extends* the default `skills/`
  scan (Claude Code plugins reference, "Plugin manifest schema"). The
  generated `.claude-plugin/plugin.json` lists one entry per skill
  (`./library/skills/<slug>/`). The docs do not say whether a listed
  directory is loaded as one skill or scanned for skill subfolders, and this
  repo has not yet loaded the generated manifest through the real plugin
  path (the smoke tests exercise the `summer setup` install path, not the
  marketplace one) — treat the marketplace install as unverified until that
  run exists.
- **Codex** — `.codex-plugin/plugin.json` carries the same per-skill `skills`
  array. Whether Codex reads that field, and with which type, is
  **unverified**; the v2 manifest carried it and nobody has confirmed a load.
- **Factory** — reads skills only from a root `skills/` directory; the
  manifest's `skills` array is not read (open gap, see the table).

| Client | Manifest generated in this repo | `summer setup` writes |
|---|---|---|
| claude | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json` | MCP: `~/.claude.json` (user) / `.mcp.json` (project); skills: `~/.claude/skills/` (user) / `.claude/skills/` (project); slash commands from `commands/` to `~/.claude/commands/` |
| codex | `.codex-plugin/plugin.json` | MCP: `~/.codex/config.toml` (TOML); skills: `.agents/skills/` |
| cursor | `.cursor-plugin/plugin.json` | MCP: `~/.cursor/mcp.json` / `.cursor/mcp.json`; skills: `.cursor/rules/` |
| factory | `.factory-plugin/plugin.json` | nothing — there is no `summer setup factory` target. Install via the plugin marketplace: `droid plugin marketplace add https://github.com/SummerEngine/summer-engine-agent` then `droid plugin install summer@summer-engine`. Factory reads MCP from the plugin's `.mcp.json` and skills only from a root `skills/` dir (this package ships them under `library/skills/`, so the manifest `skills` array is not read by Factory — open gap) |
| gemini | `gemini-extension.json` | extension dir `~/.gemini/extensions/summer-engine/`: the generated manifest (renamed `summer-engine` to match the dir, MCP launcher swapped to `npx -y summer-engine@latest mcp`) + `GEMINI.md` + `AGENTS.md`; skills: `~/.gemini/extensions/summer-engine/skills/<slug>/SKILL.md` (Gemini extension-skill discovery; user scope only) |
| windsurf (Devin Desktop) | — | MCP: `~/.codeium/windsurf/mcp_config.json`; rules: `.windsurfrules` |
| cline | — | MCP: VS Code global storage (`saoudrizwan.claude-dev`); rules: `.clinerules` |
| roo-code | — | MCP: VS Code global storage (`rooveterinaryinc.roo-cline`); rules: `.clinerules` |
| kilo-code | — | MCP: VS Code global storage `kilocode.kilo-code/settings/mcp_settings.json` (user) / `.kilocode/mcp.json` (project); rules: `~/.kilocode/rules/` (user) / `.kilocode/rules/` (project) |
| github-copilot | — | MCP: `~/.copilot/mcp-config.json` / `.mcp.json`; skills: `~/.copilot/skills/` or `.github/skills/` |
| vscode-copilot | — | MCP: VS Code user-profile `mcp.json` / `.vscode/mcp.json`; skills: `~/.copilot/skills/` or `.github/skills/` |
| opencode | — (JS plugin via npm `main`, `.opencode/plugins/summer.js`) | MCP entry in `opencode.json` (`type: "local"`, array `command`); skills: the plugin registers `library/skills/` via `skills.paths`; `skills install --agent opencode` additionally writes `agents/summer/` markdown |
| lm-studio | — | MCP: `~/.lmstudio/mcp.json` (app-global); no skills folder — guidance via `summer_get_agent_playbook` |

Source of truth for the setup paths: `src/installer/agent-config.ts` and
`src/cli/commands/skills.ts`.
