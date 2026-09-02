# Kilo Code integration

No manifest file is generated in this repo for Kilo Code — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup kilo-code`, which writes:

- MCP config: Kilo Code's VS Code global storage
  (`<VS Code user dir>/globalStorage/kilocode.kilo-code/settings/mcp_settings.json`,
  user scope) or `./.kilocode/mcp.json` (project scope).
- Skills: `summer setup kilo-code` installs the whole library in the same
  scope as the MCP config (user by default), as rule files in
  `~/.kilocode/rules/summer-<skill>.md` (user) or `./.kilocode/rules/`
  (project). `summer skills install --agent kilo-code` on its own defaults
  to project scope; pass `--scope user` to match a user-scope MCP config.

Source of truth: `src/installer/agent-config.ts`, `src/cli/commands/skills.ts`.
