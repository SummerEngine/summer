# Roo Code integration

> **Legacy.** Roo Code is no longer maintained. The target still works; consider Cline or Kilo Code.

No manifest file is generated in this repo for Roo Code — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup roo-code` (aliases: `roo`, `roocode`), which writes:

- MCP config: `~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`; Linux `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`; Windows `%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json` (user); user scope only (project requests fall back with a warning).
  Shape: `mcpServers.summer-engine = { command, args }`.
- Skills: `~/Documents/Roo/Rules` (user) or `.clinerules` (project) as rule files `summer-<skill>.md`.
- After: Restart VS Code so Roo Code reloads its MCP config.

Source of truth: `src/installer/agent-table.ts` (one row per agent).
