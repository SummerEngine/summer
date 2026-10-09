# Rovo Dev CLI integration

No manifest file is generated in this repo for Rovo Dev CLI — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup rovo-dev` (aliases: `rovodev`, `rovo`, `atlassian-rovo-dev`), which writes:

- MCP config: `~/.rovodev/mcp.json`; Windows `%USERPROFILE%/.rovodev/mcp.json` (user); user scope only (project requests fall back with a warning).
  Shape: `mcpServers.summer-engine = { command, args, transport: "stdio" }`.
- Skills: `~/.agents/skills` (user) or `.agents/skills` (project) as `<skill>/SKILL.md`.
- After: Restart Rovo Dev CLI so it reconnects its MCP servers.

Source of truth: `src/installer/agent-table.ts` (one row per agent).
