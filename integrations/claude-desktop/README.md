# Claude Desktop integration

No manifest file is generated in this repo for Claude Desktop — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup claude-desktop` (aliases: `claude-app`, `claudedesktop`), which writes:

- MCP config: `~/Library/Application Support/Claude/claude_desktop_config.json`; Linux `~/.config/Claude/claude_desktop_config.json`; Windows `%APPDATA%/Claude/claude_desktop_config.json` (user); user scope only (project requests fall back with a warning).
  Shape: `mcpServers.summer-engine = { command, args }`.
- Skills: none. Claude Desktop has no skills folder. The MCP server ships summer_docs_search and summer_docs_read, so the model can pull Summer guidance in-chat.
- After: Quit and reopen Claude Desktop; the summer-engine tools appear under the tools menu in a new chat.

Source of truth: `src/installer/agent-table.ts` (one row per agent).
