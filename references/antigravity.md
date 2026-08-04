# Antigravity setup

Antigravity is an MCP client. Its selected Google or third-party model is a
separate setting and Summer setup does not change it.

## One-command project setup

Update the terminal client, then open a terminal in the Summer project:

```bash
agy update
```

Run:

```bash
npx -y summer-engine@latest setup antigravity --yes --force --project "$PWD"
```

This creates or merges:

- `.agents/mcp_config.json` with the `summer-engine` MCP server;
- `.agents/skills/<skill>/SKILL.md` with recommended Summer guidance.

Other MCP servers and unrelated JSON keys are preserved. The server command is
bound to the absolute project path, so it does not guess when several Summer
editors are open. Antigravity's model and provider settings are not changed.

For a user-wide install, run without `--project` and add `--scope user`. The
equivalent global paths are `~/.gemini/config/mcp_config.json` and
`~/.gemini/config/skills/`.

## Reload and verify

In the desktop app, open Antigravity Settings > Customizations > MCP Servers.
In the terminal client, start `agy` from the configured project and run `/mcp`.

1. Refresh or restart `summer-engine` and inspect its connection status.
2. Confirm the host itself lists Summer tools. `summer doctor` only proves the
   server can register them; it does not prove Antigravity loaded them.
3. Keep MCP permissions in Ask mode for the first test.
4. Start a fresh conversation in the project and ask:

```text
Use the summer-engine MCP server. Call summer_get_agent_playbook and read its
result. Then call summer_get_project_context and summer_get_scene_tree. Report
the exact project and scene you found. Do not change anything. If a call fails,
quote the error and stop.
```

Only proceed to mutations when the model can discover the server, call a tool,
consume its result, and report the correct project identity.

In the tested `agy` 1.1.10 build, a normal interactive session loaded the
project-scoped server, called and consumed the playbook, project context, and
scene tree, then completed a reversible add, save, read-back, remove, save, and
clean-tree check through Summer MCP.

Do not use `agy -p` (headless print mode) as the MCP readiness check in that
build. Print mode rejected the same working project server with
`tool ... is not enabled for server summer-engine`, while a normal interactive
`agy` session succeeded. If that exact error appears under `-p`, start `agy`
normally in the configured project, run `/mcp`, and test in a fresh interactive
conversation. If the normal session also rejects the call, stop before
mutations and report the error.

## Manual configuration

Current Antigravity versions use `.agents/mcp_config.json` for workspace setup
and `~/.gemini/config/mcp_config.json` for global setup. The file has a top-level
`mcpServers` object:

```json
{
  "mcpServers": {
    "summer-engine": {
      "command": "npx",
      "args": [
        "-y",
        "summer-engine@latest",
        "mcp",
        "--project",
        "/absolute/path/to/your-project"
      ]
    }
  }
}
```

The older `.vscode/mcp.json` instructions describe a legacy IDE compatibility
path, not Antigravity's current native MCP configuration. Prefer `.agents`.
