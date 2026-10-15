# GitHub Copilot in Visual Studio integration

No manifest file is generated in this repo for GitHub Copilot in Visual Studio — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup visual-studio` (aliases: `vs`, `vs2026`, `visual-studio-2026`, `visualstudio`), which writes:

- MCP config: `~/.mcp.json`; Windows `%USERPROFILE%/.mcp.json` (user); `.mcp.json` (project).
  Shape: `servers.summer-engine = { type: "stdio", command, args }`.
- Skills: none. Visual Studio's Copilot has no skills folder yet; the MCP server ships summer_docs_search and summer_docs_read for in-chat guidance.
- After: Restart Visual Studio, open Copilot Chat in Agent mode, and enable summer-engine in the tools picker.

Source of truth: `src/installer/agent-table.ts` (one row per agent).
