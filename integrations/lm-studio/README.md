# LM Studio integration

No manifest file is generated in this repo for LM Studio —
`manifest-target.json` is intentionally empty. Support is delivered at install
time by `summer setup lm-studio`, which writes:

- MCP config: `~/.lmstudio/mcp.json`. This file is app-global (user scope
  only); project-scope requests are treated as user scope with a warning.
- Skills: LM Studio has no rules or skills folder. The MCP server ships
  `summer_get_agent_playbook`, so the model pulls Summer guidance in-chat.

Source of truth: `src/installer/agent-config.ts`, `src/installer/setup.ts`.
