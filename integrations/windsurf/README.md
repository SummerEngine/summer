# Devin Desktop integration

No manifest file is generated in this repo for Devin Desktop — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup windsurf` (aliases: `devin`, `devin-desktop`, `devindesktop`), which writes:

- MCP config: `~/.codeium/windsurf/mcp_config.json`; Windows `%USERPROFILE%/.codeium/windsurf/mcp_config.json` (user); user scope only (project requests fall back with a warning).
  Shape: `mcpServers.summer-engine = { command, args }`.
- Skills: `~/.agents/skills` (user) or `.agents/skills` (project) as `<skill>/SKILL.md`.
- After: Restart Devin Desktop and refresh MCP servers from the agent settings. Devin's docs say mcp_config.json configures the Cascade agent; for the Devin agent add the server in the app's MCP settings with the same command.

Source of truth: `src/installer/agent-table.ts` (one row per agent).
