# VS Code Copilot integration

No manifest file is generated in this repo for VS Code Copilot —
`manifest-target.json` is intentionally empty. Support is delivered at install
time by `summer setup vscode-copilot`, which writes:

- MCP config: VS Code's user-profile `mcp.json` (user scope) or
  `./.vscode/mcp.json` (project scope), in VS Code's MCP config format.
- Skills: `summer skills install --agent vscode-copilot` writes skill files to
  `~/.copilot/skills/` (user scope) or `./.github/skills/` (project scope).

Source of truth: `src/installer/agent-config.ts`, `src/cli/commands/skills.ts`.
