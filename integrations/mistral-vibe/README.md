# Mistral Vibe integration

No manifest file is generated in this repo for Mistral Vibe — `manifest-target.json`
is intentionally empty. Support is delivered at install time by
`summer setup mistral-vibe` (aliases: `vibe`, `mistral`), which writes:

- MCP config: `~/.vibe/config.toml`; Windows `%USERPROFILE%/.vibe/config.toml` (user); `.vibe/config.toml` (project).
  Shape: a `[[mcp_servers]]` entry with `name`, `transport`, `command`, `args` (TOML).
- Skills: `~/.vibe/skills` (user) or `.agents/skills` (project) as `<skill>/SKILL.md`.
- After: Restart Vibe so it reloads config.toml.

Source of truth: `src/installer/agent-table.ts` (one row per agent).
