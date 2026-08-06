# Copy-Paste Setup Prompt

Use this when a human wants to connect Summer MCP from a supported client. The
MCP client and model provider are separate choices: OpenCode does not imply LM
Studio, and LM Studio can host MCP directly without OpenCode.

Source: https://github.com/SummerEngine/summer-engine-agent
MCP setup page: https://summerengine.com/mcp

Paste this into the AI environment:

```text
Set up Summer MCP for the agent I am using and the current project. Identify
the MCP client separately from its model provider, then run
`npx -y summer-engine@latest setup <client> --yes --force --project "$PWD"`
with the correct supported client target. Use `opencode` for OpenCode,
`lm-studio` when chatting directly in LM Studio, and `antigravity` for
Antigravity. If the client target is uncertain, run setup help and use only a
listed target; do not invent one. Do not change my model provider, install the
engine app, sign me in, or create a project unless I explicitly ask. Run
doctor, show me the config path, and verify that `summer-engine` tools are
visible before changing the project.
```

The prompt deliberately contains the executable contract. A smaller model does
not need to infer the client/provider distinction or scrape a README first.

Expected agent behavior:

1. Check Node.js 18+.
2. Select the client target, never the model provider.
3. Run the exact `setup` command with an explicit project path.
4. Read the setup result and run `doctor --json`.
5. Reload the client and verify `summer-engine` plus a read-only tool call.
6. Stop and quote the exact error if tool discovery or the read-only call fails.

First-class setup targets: `claude-code`, `codex`, `cursor`, `windsurf`, `cline`, `roo-code`, `kilo-code`, `gemini`, `github-copilot`, `vscode-copilot`, `opencode`, `lm-studio`, `antigravity`.

Common recipes are opt-in additions, not aliases for clients. For example,
OpenCode + LM Studio may add `--lm-studio-model <loaded-id>`; plain OpenCode
setup must never write provider or model keys. Direct LM Studio setup uses the
`lm-studio` target and does not require OpenCode.

Factory Droid uses its plugin marketplace path today. Other older-school or adjacent surfaces worth watching are Continue, Aider, Zed, JetBrains AI/Junie, Goose, and Amp; do not claim first-class Summer setup support for those until a real config target exists.

Engine download, login, project creation, and provider configuration are
separate workflows. The MCP setup prompt must not silently broaden into them.
