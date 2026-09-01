# GitHub Copilot CLI integration

No manifest file is generated in this repo for Copilot CLI —
`manifest-target.json` is intentionally empty. Support is delivered at install
time by `summer setup github-copilot`, which writes:

- MCP config: `~/.copilot/mcp-config.json` (user scope) or `./.mcp.json`
  (project scope), in Copilot's MCP config format.
- Skills: `summer skills install --agent github-copilot` writes skill files to
  `~/.copilot/skills/` (user scope) or `./.github/skills/` (project scope).

Source of truth: `src/installer/agent-config.ts`, `src/cli/commands/skills.ts`.
