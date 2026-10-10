# integrations/: which agents Summer supports

One folder per supported client. Each folder says how that client consumes
the library.

Adding an agent: one row in `src/installer/agent-table.ts`, one folder here,
an empty entry in `scripts/generate-registry/targets.ts` (plus a builder in
`scripts/generate-registry/manifests.ts` if the client has a manifest file),
then `npm run generate:registry`. Never hand-edit root files. Tests fail when
the table, this directory and `targets.ts` disagree.

Each folder contains:

- `README.md`: what gets generated where, or (for clients with no manifest
  file in this repo) what `summer setup <client>` writes at install time.
- `manifest-target.json`: generated file -> repo-root destination (empty when
  nothing is generated). Mirrors `scripts/generate-registry/targets.ts`; a test
  fails if they drift.

`summer setup <client>` (default `--scope user`) writes the MCP config and
installs every skill (`skills install --all`, preview included;
`--stable-only` skips preview) in the same scope, so a user-scope MCP config
never sits beside project-scope skills. `--scope project` moves both;
`--recommended` installs only the recommended subset. Clients whose MCP config
is user-only fall back to user scope with a warning.

Generated root files (`.claude-plugin/plugin.json`, `gemini-extension.json`,
`.mcp.json`, …) are build artifacts of `integrations/<agent>` + `library/`.
Their `_generated` banner says so. CI `--check` fails on any drift between
`library/`, `registry/generated/` and the applied root files.

How the plugin manifests reference skills, and what is verified:

- **Claude Code**: the plugin-manifest `skills` field accepts a string or an
  array of `./`-relative directory paths and extends the default `skills/`
  scan. The generated `.claude-plugin/plugin.json` lists one entry per skill
  (`./library/skills/<slug>/`). The docs do not say whether a listed directory
  loads as one skill or is scanned for skill subfolders, and the smoke tests
  cover the `summer setup` path, not the marketplace one. Treat the
  marketplace install as unverified.
- **Codex**: `.codex-plugin/plugin.json` carries the same `skills` array.
  Whether Codex reads that field is **unverified**.
- **Factory**: a plugin install reads skills only from a root `skills/`
  directory, so it exposes no skills. `summer setup factory` installs them.

Paths below are for macOS; `~` is `%USERPROFILE%` on Windows. Other OS paths
are listed where they differ.

| Client | Manifest generated in this repo | `summer setup` writes |
|---|---|---|
| claude | `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json` | MCP: `~/.claude.json`; project `.mcp.json`; skills: `~/.claude/skills`; project `.claude/skills` (`<skill>/SKILL.md`) |
| claude-desktop | — | MCP: `~/Library/Application Support/Claude/claude_desktop_config.json`; Linux `~/.config/Claude/claude_desktop_config.json`; Windows `%APPDATA%/Claude/claude_desktop_config.json`; no skills folder (MCP only) |
| codex | `.codex-plugin/plugin.json` | MCP: `~/.codex/config.toml`; project `.codex/config.toml`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| cursor | `.cursor-plugin/plugin.json` | MCP: `~/.cursor/mcp.json`; project `.cursor/mcp.json`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| windsurf | — | MCP: `~/.codeium/windsurf/mcp_config.json`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| antigravity | — | MCP: `~/.gemini/config/mcp_config.json`; project `.agents/mcp_config.json`; skills: `~/.gemini/config/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| gemini (legacy) | `gemini-extension.json` | MCP: `~/.gemini/extensions/summer-engine/gemini-extension.json`; skills: `~/.gemini/extensions/summer-engine/skills` (`<skill>/SKILL.md`) |
| cline | — | MCP: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`; Linux `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`; Windows `%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`; skills: `~/.cline/skills`; project `.cline/skills` (`<skill>/SKILL.md`) |
| cline-cli | — | MCP: `~/.cline/data/settings/cline_mcp_settings.json`; skills: `~/.cline/skills`; project `.cline/skills` (`<skill>/SKILL.md`) |
| roo-code (legacy) | — | MCP: `~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`; Linux `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`; Windows `%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`; skills: `~/Documents/Roo/Rules`; project `.clinerules` (rule files `summer-<skill>.md`) |
| kilo-code | — | MCP: `~/.config/kilo/kilo.json`; Windows `%APPDATA%/kilo/kilo.json`; project `kilo.json`; skills: `~/.kilo/skills`; project `.kilo/skills` (`<skill>/SKILL.md`) |
| github-copilot | — | MCP: `~/.copilot/mcp-config.json`; project `.mcp.json`; skills: `~/.copilot/skills`; project `.github/skills` (`<skill>/SKILL.md`) |
| vscode-copilot | — | MCP: `~/Library/Application Support/Code/User/mcp.json`; Linux `~/.config/Code/User/mcp.json`; Windows `%APPDATA%/Code/User/mcp.json`; project `.vscode/mcp.json`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| visual-studio | — | MCP: `~/.mcp.json`; project `.mcp.json`; no skills folder (MCP only) |
| copilot-jetbrains | — | MCP: `~/.config/github-copilot/intellij/mcp.json`; Windows `%APPDATA%/github-copilot/intellij/mcp.json`; no skills folder (MCP only) |
| opencode | — | MCP: `~/.config/opencode/opencode.json`; Windows `%APPDATA%/opencode/opencode.json`; project `opencode.json`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| zed | — | MCP: `~/.config/zed/settings.json`; Windows `%APPDATA%/zed/settings.json`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| kiro | — | MCP: `~/.kiro/settings/mcp.json`; project `.kiro/settings/mcp.json`; skills: `~/.kiro/skills`; project `.kiro/skills` (`<skill>/SKILL.md`) |
| goose | — | MCP: `~/.config/goose/config.yaml`; Windows `%APPDATA%/Block/goose/config/config.yaml`; skills: `~/.config/agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| hermes | — | MCP: `~/.hermes/config.yaml`; skills: `~/.hermes/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| trae | — | MCP: `.trae/mcp.json` (project only); no skills folder (MCP only) |
| qwen-code | — | MCP: `~/.qwen/settings.json`; project `.qwen/settings.json`; skills: `~/.qwen/skills`; project `.qwen/skills` (`<skill>/SKILL.md`) |
| kimi-code | — | MCP: `~/.kimi-code/mcp.json`; project `.kimi-code/mcp.json`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| crush | — | MCP: `~/.config/crush/crushrc`; project `.crushrc`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| amp | — | MCP: `~/.config/amp/settings.json`; Windows `%APPDATA%/amp/settings.json`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| factory | `.factory-plugin/plugin.json` | MCP: `~/.factory/mcp.json`; project `.factory/mcp.json`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| junie | — | MCP: `~/.junie/mcp/mcp.json`; project `.junie/mcp/mcp.json`; no skills folder (MCP only) |
| warp | — | MCP: `~/.warp/.mcp.json`; project `.warp/.mcp.json`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| rovo-dev | — | MCP: `~/.rovodev/mcp.json`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| qoder | — | MCP: `~/.qoder/settings.json`; project `.mcp.json`; skills: `~/.qoder/skills`; project `.qoder/skills` (`<skill>/SKILL.md`) |
| grok-build | — | MCP: `~/.grok/config.toml`; project `.grok/config.toml`; skills: `~/.agents/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| mistral-vibe | — | MCP: `~/.vibe/config.toml`; project `.vibe/config.toml`; skills: `~/.vibe/skills`; project `.agents/skills` (`<skill>/SKILL.md`) |
| lm-studio | — | MCP: `~/.lmstudio/mcp.json`; no skills folder (MCP only) |

Source of truth for the setup paths: `src/installer/agent-table.ts`.

Not supported on purpose (checked 2026-09-11): OpenHands CLI (its `[mcp] stdio_servers`
inline-table array has a known upstream write bug), Xcode's agent folders (Apple
documents the folder but not the file names), Pi (no MCP by design), Aider,
ChatGPT desktop, Replit, Perplexity, JetBrains AI Assistant and Android Studio
(UI-only MCP), Continue.dev (shut down), Void (archived), Cody (enterprise only).
Grok Build also reads `~/.claude.json` and `.cursor/mcp.json`, so a Claude Code or
Cursor setup already covers it; `summer setup grok-build` writes its own file too.
