# Kilo Code integration

No manifest file is generated in this repo for Kilo Code — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup kilo-code`, which writes:

- MCP config: Kilo Code's VS Code global storage
  (`kilocode.kilo-code/mcp_settings.json`, user scope) or
  `./.kilocode/mcp.json` (project scope).
- Skills: `summer skills install --agent kilo-code` writes rule files to
  `~/.kilocode/rules/` (user scope) or `./.kilocode/rules/` (project scope).

Source of truth: `src/installer/agent-config.ts`, `src/cli/commands/skills.ts`.
