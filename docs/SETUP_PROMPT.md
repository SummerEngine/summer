# Copy-Paste Setup Prompt

Use this when a human wants to install Summer Engine from Claude Code, Cursor, Codex, Devin Desktop (formerly Windsurf), Cline, Roo Code, Gemini CLI, GitHub Copilot CLI, GitHub Copilot in VS Code, or OpenCode.

Source: https://github.com/SummerEngine/summer-engine-agent
MCP setup page: https://summerengine.com/mcp

Paste this into the AI environment:

```text
Install Summer Engine and let's make a game.
```

The agent should read the Summer README/install playbook, detect the current machine state, and run only the missing setup steps with `npx -y summer-engine@latest`.

Expected agent behavior:

1. Check Node.js 20+.
2. Run `npx -y summer-engine@latest doctor --json` (its top-level `ok` means "no check failed", not "installed").
3. Always run `npx -y summer-engine@latest setup <agent> --yes --force` — idempotent; installs every skill and the MCP config.
4. Run `npx -y summer-engine@latest install` if the `engine-install` check needs attention.
5. Run `npx -y summer-engine@latest login` if the `login` check needs attention.
6. Create and run a starter project only after choosing a stable parent directory.
7. Use the `brainstorm-game` skill before building from a vague prompt.

First-class setup targets: `claude-code`, `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `kilo-code`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`, `lm-studio`.

Factory Droid uses its plugin marketplace path today. Other older-school or adjacent surfaces worth watching are Continue, Aider, Zed, JetBrains AI/Junie, Goose, and Amp; do not claim first-class Summer setup support for those until a real config target exists.

Manual terminal commands are still supported, but the primary onboarding path is the copy-paste prompt. This keeps users out of npm/global install details and lets their AI agent handle platform-specific setup.
