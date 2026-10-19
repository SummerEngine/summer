# Copy-Paste Setup Prompt

Use this when a human wants to install Summer Engine from any MCP-capable coding agent: Claude Code, Claude Desktop, Codex, Cursor, Devin Desktop, Antigravity, Cline (VS Code), Cline CLI, Kilo Code, GitHub Copilot CLI, GitHub Copilot in VS Code, GitHub Copilot in Visual Studio, GitHub Copilot in JetBrains IDEs, OpenCode, Zed, Kiro, Goose, Hermes Agent, Trae, Qwen Code, Kimi Code CLI, Crush, Amp, Factory Droid, Junie, Warp, Rovo Dev CLI, Qoder CLI, Grok Build, Mistral Vibe, LM Studio.

Source: https://github.com/summerengine/summer
MCP setup page: https://summerengine.com/mcp

Paste this into the AI environment:

```text
Install Summer Engine and let's make a game. Read github.com/summerengine/summer, check what I already have installed, install whatever is missing, and open a starter project so we can start building.
```

The agent should read the Summer README/install playbook, detect the current machine state, and run only the missing setup steps with `npx -y summer-engine@latest`.

Expected agent behavior:

1. Check Node.js 20+. On Windows, install Node LTS with winget if it is missing (after asking), and type `npx.cmd` instead of `npx` in PowerShell.
2. Run `npx -y summer-engine@latest doctor --json` (its top-level `ok` means "no check failed", not "installed").
3. Always run `npx -y summer-engine@latest setup <agent> --yes --force` — idempotent; installs every skill and the MCP config. For most agents it also connects Summer Games (`summer-games`); tell the user the one `Sign in once:` step setup prints, then continue.
4. After choosing a stable parent directory and asking the user's OK to install the engine (about 660 MB, free), run `npx -y summer-engine@latest dev --yes <template> <folder>` (default template `3d-basic`): it installs the engine if it is missing, creates the project, opens it and waits until the editor answers.
5. Building needs no sign-in. Run `npx -y summer-engine@latest login` only when the user wants cloud work (assets, publishing) or a tool answers `not_signed_in`.
6. Use the `brainstorm-game` skill before building from a vague prompt.

First-class setup targets: `claude-code`, `claude-desktop`, `codex`, `cursor`, `windsurf`, `antigravity`, `cline`, `cline-cli`, `kilo-code`, `github-copilot`, `vscode-copilot`, `visual-studio`, `copilot-jetbrains`, `opencode`, `zed`, `kiro`, `goose`, `hermes`, `trae`, `qwen-code`, `kimi-code`, `crush`, `amp`, `factory`, `junie`, `warp`, `rovo-dev`, `qoder`, `grok-build`, `mistral-vibe`, `lm-studio`. Legacy (still accepted): `gemini`, `roo-code`.

Manual terminal commands still work, but the copy-paste prompt is the main path: the agent handles npm and platform details.

Cloud work only (assets, plans, the store, publishing, prices, analytics) needs no install: add `https://mcp.summerengine.com/mcp` to the agent and sign in once. The README's "Connect" section has the line for each agent.
