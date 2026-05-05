# Codex

Codex can use Summer skills from the standard `.agents/skills` locations.

## Install Skills

User-wide:

```bash
summer skills install --recommended --agent codex --scope user
```

Project-local:

```bash
summer skills install --recommended --agent codex --scope project
```

Paths:

- User scope: `~/.agents/skills/<skill>/SKILL.md`
- Project scope: `.agents/skills/<skill>/SKILL.md`

## MCP

Configure your Codex environment to run the Summer MCP server with:

```bash
npx summer-engine mcp
```

Keep Summer Engine running on the project while the agent works:

```bash
summer run path/to/project
```

## Prompt Seed

Ask Codex to use the installed Summer skills and the Summer MCP tools for editor operations. Scripts and text files should be edited with Codex's normal file tools; scenes should be changed through Summer tools and then saved.

