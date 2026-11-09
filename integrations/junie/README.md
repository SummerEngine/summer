# Junie integration

No manifest file is generated in this repo for Junie — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup junie` (aliases: `jetbrains-junie`), which writes:

- MCP config: `~/.junie/mcp/mcp.json`; Windows `%USERPROFILE%/.junie/mcp/mcp.json` (user); `.junie/mcp/mcp.json` (project).
  Shape: `mcpServers.summer-engine = { command, args }`.
- Skills: none. Junie has no skills folder; put project guidance in .junie/guidelines.md. The MCP server ships summer_docs_search and summer_docs_read for in-chat guidance.
- After: Restart the JetBrains IDE so Junie reloads its MCP config.

Source of truth: `src/installer/agent-table.ts` (one row per agent).
