# Windsurf (Devin Desktop) integration

No manifest file is generated in this repo for Windsurf — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup windsurf`, which writes:

- MCP config: `~/.codeium/windsurf/mcp_config.json` (user scope; project scope
  writes `.windsurf/mcp_config.json` for teams that load workspace config —
  Windsurf documents MCP configuration as user-scoped).
- Skills: `summer skills install --agent windsurf` writes the `.windsurfrules`
  rule file (`~/.windsurfrules` user scope, `./.windsurfrules` project scope).

Source of truth: `src/installer/agent-config.ts`, `src/cli/commands/skills.ts`.
