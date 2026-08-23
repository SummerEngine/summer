# Bionic

[LM Studio Bionic](https://lmstudio.ai/docs/bionic) is a separate agentic app from LM Studio. It supports local models and cloud-hosted open models, local coding projects, MCP servers, and standard [Agent Skills](https://lmstudio.ai/docs/bionic/agent/skills).

## Recommended Setup

Run this from the Summer game directory:

```bash
npx -y summer-engine@latest setup bionic --scope project --yes --force
```

This performs two setup steps:

- publishes the `summer-engine` stdio entry to the public [`~/.lmstudio/mcp.json`](https://lmstudio.ai/docs/app/mcp) integration file, which Bionic discovers under Connected Apps, and binds it to the current game;
- installs Summer Agent Skills under `.agents/skills/<skill>/SKILL.md`.

The published MCP registration is app-global. Bionic currently starts global MCP servers outside the active Code Project and does not advertise MCP Roots. Project-scope setup therefore pins both its stdio `cwd` and `SUMMER_ENGINE_PROJECT` to the current directory. Because Bionic does not update that global connection when its active Code Project changes, re-run the setup command from the new game directory when switching projects.

If you always run exactly one Summer editor and prefer global skills, use user scope instead:

```bash
npx -y summer-engine@latest setup bionic --yes --force
```

User scope installs skills under `~/.lmstudio/skills/<skill>/SKILL.md` and leaves editor discovery automatic.

Bionic owns its internal enabled/connection state; Summer does not write Bionic's private app-state files.

## Enable Summer in Bionic

1. Open **Settings → Connected Apps**.
2. Enable `summer-engine` and confirm that its tools are ready.
3. Open **Settings → Skills** and verify that the Summer skills are enabled.

If the MCP entry does not appear after setup, restart Bionic and check **Connected Apps** again.

## Project Skills

For project skills without changing MCP configuration, run this from the project root (the recommended setup command above already does this):

```bash
npx -y summer-engine@latest skills install --recommended --agent bionic --scope project
```

This writes standard Agent Skills to `.agents/skills/<skill>/SKILL.md`, a discovery path covered by the [Bionic changelog](https://lmstudio.ai/changelog). Bionic can also expose compatible skills already installed for Codex or Claude Code through **Settings → Skills → Use skills found in other apps**.

## Run Summer Engine

Keep Summer Engine open on the same project while Bionic works:

```bash
npx -y summer-engine@latest run path/to/project
```

Use a model with reliable tool calling and enough context for the Summer MCP tool schemas. Bionic should use Summer MCP for project files, scene/editor operations, play mode, and diagnostics.
