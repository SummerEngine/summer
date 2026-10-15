# LM Studio integration

No manifest file is generated in this repo for LM Studio — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup lm-studio` (aliases: `lmstudio`, `lm_studio`), which writes:

- MCP config: `~/.lmstudio/mcp.json`; Windows `%USERPROFILE%/.lmstudio/mcp.json` (user); user scope only (project requests fall back with a warning).
  Shape: `mcpServers.summer-engine = { command, args }`.
- Skills: none. LM Studio has no rules or skills folder. The MCP server ships summer_docs_search and summer_docs_read, so the model can pull Summer guidance in-chat.
- After: Open LM Studio, toggle on the summer-engine MCP server in the Program tab, and raise the loaded model's context length to 32k or higher.

Source of truth: `src/installer/agent-table.ts` (one row per agent).
