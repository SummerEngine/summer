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
- `manifest-target.json` — mapping of generated file -> repo-root destination
  (empty when nothing is generated). Mirrors
  `scripts/generate-registry/targets.ts`; a test fails if they drift.

Generated root dot-files (`.claude-plugin/plugin.json`, `gemini-extension.json`,
…) are build artifacts of `integrations/<agent>` + `library/` — their
`_generated` banner says so ("GENERATED from integrations/<agent> — do not
edit; npm run generate:registry"). CI `--check` fails on any drift between
`library/`, `registry/generated/`, and the applied root files.

| Client | Manifest generated in this repo | `summer setup` writes |
|---|---|---|
| claude | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | MCP: `~/.claude.json` (user) / `.mcp.json` (project); skills: `.claude/skills/` |
| codex | `.codex-plugin/plugin.json` | MCP: `~/.codex/config.toml` (TOML); skills: `.agents/skills/` |
| cursor | `.cursor-plugin/plugin.json` | MCP: `~/.cursor/mcp.json` / `.cursor/mcp.json`; skills: `.cursor/rules/` |
| factory | `.factory-plugin/plugin.json` | MCP via `.mcp.json`; skills via manifest |
| gemini | `gemini-extension.json` | extension: `~/.gemini/extensions/summer-engine/`; skills inside the extension dir |
| windsurf (Devin Desktop) | — | MCP: `~/.codeium/windsurf/mcp_config.json`; rules: `.windsurfrules` |
| cline | — | MCP: VS Code global storage (`saoudrizwan.claude-dev`); rules: `.clinerules` |
| roo-code | — | MCP: VS Code global storage (`rooveterinaryinc.roo-cline`); rules: `.clinerules` |
| kilo-code | — | MCP: `~/.kilocode` VS Code storage / `.kilocode/mcp.json`; rules: `.kilocode/rules/` |
| github-copilot | — | MCP: `~/.copilot/mcp-config.json` / `.mcp.json`; skills: `~/.copilot/skills/` or `.github/skills/` |
| vscode-copilot | — | MCP: VS Code user-profile `mcp.json` / `.vscode/mcp.json`; skills: `~/.copilot/skills/` or `.github/skills/` |
| opencode | — (JS plugin via npm `main`) | MCP + plugin entries in `opencode.json`; skills auto-discovered from the package |
| lm-studio | — | MCP: `~/.lmstudio/mcp.json` (app-global); no skills folder — guidance via `summer_get_agent_playbook` |

Source of truth for the setup paths: `src/installer/agent-config.ts` and
`src/cli/commands/skills.ts`.
