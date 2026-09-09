# Cline integration

No manifest file is generated in this repo for Cline — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup cline`, which writes:

- MCP config: Cline's VS Code global storage (extension
  `saoudrizwan.claude-dev`). User scope only — Cline has no project-scoped MCP
  config today; project requests fall back to user scope with a warning.
- Skills: `summer skills install --agent cline` writes rule files to Cline's
  user rules directory (user scope) or `./.clinerules` (project scope).

Source of truth: `src/installer/agent-config.ts`, `src/cli/commands/skills.ts`.
