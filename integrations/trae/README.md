# Trae integration

No manifest file is generated in this repo for Trae — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup trae` (aliases: `trae-ide`, `bytedance-trae`), which writes:

- MCP config: `.trae/mcp.json` (project only; Trae manages user-level servers in its UI, so a user-scope request writes the project file with a warning).
  Shape: `mcpServers.summer-engine = { command, args }`.
- Skills: none. Trae documents no skills folder; the MCP server ships summer_get_agent_playbook for in-chat guidance.
- After: Restart Trae and open the MCP settings; summer-engine should show as connected.

Source of truth: `src/installer/agent-table.ts` (one row per agent).
