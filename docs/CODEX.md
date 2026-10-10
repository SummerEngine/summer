# Codex

Codex can use Summer skills from the standard `.agents/skills` locations.

## Recommended Setup

Paste this into Codex:

```text
Install Summer Engine and let's make a game.
```

Codex runs the install playbook from the README: it installs the skills, configures MCP, runs doctor, and opens the engine.

## Install Skills

User-wide:

```bash
npx -y summer-engine@latest setup codex --yes --force
```

Project-local:

```bash
npx -y summer-engine@latest skills install --recommended --agent codex --scope project
```

Paths:

- User scope: `~/.agents/skills/<skill>/SKILL.md`
- Project scope: `.agents/skills/<skill>/SKILL.md`

## MCP

`summer setup codex` adds the server to `~/.codex/config.toml`. The command it runs:

```bash
npx -y summer-engine@latest mcp
```

Keep Summer Engine running on the project while the agent works:

```bash
npx -y summer-engine@latest run path/to/project
```

## Prompt Seed

Ask Codex to use the installed Summer skills and Summer MCP for project operations. Scripts and text files should use `summer_read_file`, `summer_replace_text`, or guarded `summer_write_file`; live scene hierarchy changes should use Summer scene tools and then be saved.
