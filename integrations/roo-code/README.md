# Roo Code integration

No manifest file is generated in this repo for Roo Code — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup roo-code`, which writes:

- MCP config: Roo Code's VS Code global storage (extension
  `rooveterinaryinc.roo-cline`). User scope only — no project-scoped MCP config
  today; project requests fall back to user scope with a warning.
- Skills: `summer skills install --agent roo-code` writes rule files to Roo
  Code's user rules directory (user scope) or `./.clinerules` (project scope).

Source of truth: `src/installer/agent-config.ts`, `src/cli/commands/skills.ts`.
