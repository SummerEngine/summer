# LM Studio manual setup

LM Studio can host MCP servers and run a local model, but it is not a full
coding agent. It does not read Summer skills from disk, choose a project folder,
or repair its own MCP configuration. This guide covers those manual steps.

## Fast setup

Open the Summer project in Summer Engine first. Then run this in a terminal:

LM Studio Chat cannot execute this installer or repair its own MCP config. Do
not paste the coding-agent install prompt into the local model. Run the command
yourself in a normal terminal, or follow the in-app manual path below.

```bash
npx -y summer-engine@latest setup lm-studio --yes --project "/absolute/path/to/your-project"
```

The setup command:

- updates the active LM Studio `mcp.json` without replacing other servers;
- binds Summer tools to the named project;
- exposes the same complete Summer MCP tool registry used by other clients;
- prints the exact file it updated and the next LM Studio steps.

You may omit `--project` when only one Summer editor is running. Keep it when
you regularly open more than one project. An unscoped MCP server fails closed
instead of guessing when multiple Summer editors are available.

## Manual setup inside LM Studio

Use this path when the setup command completed but `summer-engine` is not shown.
LM Studio has changed the physical config location between releases, so its
in-app editor is the source of truth.

1. Open LM Studio once.
2. Open Chat > Integrations. Older releases call this the Program tab.
3. Choose Edit mcp.json.
4. Merge the `summer-engine` entry below into the existing `mcpServers` object.
   Do not replace or delete other servers.
5. Replace the example project path with the absolute path to your project.

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

If LM Studio reports that `npx` cannot be found, run `command -v npx` on macOS
or Linux, or `where npx` on Windows, and use the returned absolute executable
path as `command`.

## Load the model

1. Load a model that supports multi-turn tool calling, not only JSON output.
2. Use at least 64k context. Small contexts can lose tool definitions or tool
   results without an obvious error.
3. Enable only the `summer-engine` integration for the first test.
4. Keep tool confirmations enabled until you trust the model's behavior.

Summer exposes one complete MCP tool registry to every client. A local model
therefore needs enough context for the tool schemas as well as the conversation;
64k is the recommended minimum. Keep only the `summer-engine` integration
enabled for the first test so unrelated MCP servers do not consume additional
context or complicate tool selection.

## Safe first chat

Do not begin with a mutation. Start a fresh chat with this read-only smoke test:

```text
Use only the enabled Summer Engine tools. Call summer_get_agent_playbook once,
read the tool result, and summarize it. Then call summer_get_project_context
and summer_get_scene_tree and report the exact project and scene you found.
Do not change anything. If a tool fails, quote its error and do not guess.
```

Only continue when the model both calls the tools and successfully responds
after reading their results. A model that emits a tool call but cannot consume
the result is not ready to edit a project safely.

For the first mutation test, ask it to add one `MeshInstance3D` with a
`BoxMesh`, verify that the node appears, then remove it again and verify the
removal with `summer_get_scene_tree`. Only ask for
`summer_get_script_errors` after the model has identified an actual `.gd`
file; that tool does not accept a `.tscn` scene path. This proves read, write,
save, and verification without leaving test content in the scene or baiting a
small model into an invalid diagnostic call.

## Troubleshooting

### The integration is missing

Use LM Studio's in-app Edit mcp.json action and compare that file with the JSON
above. Do not assume `~/.lmstudio/mcp.json` is the active file. Current LM
Studio builds may use a runtime config under `~/.cache/lm-studio` instead.

### Summer says multiple editors are running

Add `--project` and the absolute project path to the MCP arguments, save
`mcp.json`, and restart or reload the integration.

### The model talks about tools but never calls them

Confirm that the model advertises tool use, raise context to 64k or more, start
a fresh chat, and keep only Summer enabled. A chat model that can emit JSON is
not necessarily a multi-turn tool-calling model.

### A tool call works, then the model fails on the result

Errors such as `Unknown test: sequence`, `Unknown ArrayValue filter: upper`, or
`Error rendering prompt with jinja template` come from the model's LM Studio
prompt template. They are not Summer operation failures. Update the model or
LM Studio, choose a model package with a tested tool template, or override the
prompt template in LM Studio's model settings. Do not keep retrying mutations:
the model cannot safely complete a tool loop in that state.

The default prompt template shipped for the tested
`google/gemma-4-26b-a4b-qat` MLX package produced both errors in LM Studio
0.4.20. Replacing it with the compatible `chat_template.jinja` bundled in the
downloaded model fixed the tool loop; the same model then consumed Summer tool
results successfully. In the direct LM Studio smoke it also added a
`MeshInstance3D`, assigned a `BoxMesh`, verified the scene tree, removed the
node, and verified cleanup. Reducing the Summer tool count alone does not
repair a broken template.

### Nothing changes in the engine

Read the tool-call confirmation and result. A proposed tool call is not an
applied edit. The model must receive a successful mutation result and then
verify the scene tree. Run `npx -y summer-engine@latest doctor --json` when the
local editor connection itself is unhealthy.
