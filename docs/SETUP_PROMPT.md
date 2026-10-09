# Copy-Paste Setup Prompt

Use this when a human wants to install Summer Engine from any MCP-capable coding agent: Claude Code, Claude Desktop, Codex, Cursor, Devin Desktop, Antigravity, Cline (VS Code), Cline CLI, Kilo Code, GitHub Copilot CLI, GitHub Copilot in VS Code, GitHub Copilot in Visual Studio, GitHub Copilot in JetBrains IDEs, OpenCode, Zed, Kiro, Goose, Hermes Agent, Trae, Qwen Code, Kimi Code CLI, Crush, Amp, Factory Droid, Junie, Warp, Rovo Dev CLI, Qoder CLI, Grok Build, Mistral Vibe, LM Studio.

Source: https://github.com/summerengine/summer
MCP setup page: https://summerengine.com/mcp

Paste this into the AI environment:

```text
Install Summer Engine and let's make a game.
```

The agent should read the Summer README/install playbook, detect the current machine state, and run only the missing setup steps with `npx -y summer-engine@latest`.

Expected agent behavior:

1. Check Node.js 20+. On Windows, install Node LTS with winget if it is missing (after asking), and type `npx.cmd` instead of `npx` in PowerShell.
2. Run `npx -y summer-engine@latest doctor --json` (its top-level `ok` means "no check failed", not "installed").
3. Always run `npx -y summer-engine@latest setup <agent> --yes --force` — idempotent; installs every skill and the MCP config.
4. Run `npx -y summer-engine@latest install` if the `engine-install` check needs attention.
5. Run `npx -y summer-engine@latest login` if the `login` check needs attention.
6. Create and run a starter project only after choosing a stable parent directory.
7. Use the `brainstorm-game` skill before building from a vague prompt.

First-class setup targets: `claude-code`, `claude-desktop`, `codex`, `cursor`, `windsurf`, `antigravity`, `cline`, `cline-cli`, `kilo-code`, `github-copilot`, `vscode-copilot`, `visual-studio`, `copilot-jetbrains`, `opencode`, `zed`, `kiro`, `goose`, `hermes`, `trae`, `qwen-code`, `kimi-code`, `crush`, `amp`, `factory`, `junie`, `warp`, `rovo-dev`, `qoder`, `grok-build`, `mistral-vibe`, `lm-studio`. Legacy (still accepted): `gemini`, `roo-code`.

Factory Droid uses its plugin marketplace path today. Other older-school or adjacent surfaces worth watching are Continue, Aider, Zed, JetBrains AI/Junie, Goose, and Amp; do not claim first-class Summer setup support for those until a real config target exists.

Manual terminal commands are still supported, but the primary onboarding path is the copy-paste prompt. This keeps users out of npm/global install details and lets their AI agent handle platform-specific setup.
