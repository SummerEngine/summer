# OpenCode setup

Summer Engine works in OpenCode through MCP. Installing `summer-engine` as an
OpenCode plugin is not required.

## Fast path for OpenCode

From the Summer project root, configure OpenCode itself:

```bash
npx -y summer-engine@latest setup opencode --yes --force --project "$PWD"
```

This writes project-scoped MCP config and Summer guidance, preserves unrelated
OpenCode config, and does not add or change any model provider. OpenCode
receives the same complete Summer MCP tool registry as every other client.

Restart OpenCode after setup. A running OpenCode process does not discover a
new MCP server or newly installed guidance from config written mid-session.

## Optional recipe: OpenCode with LM Studio

1. In LM Studio, load a tool-calling model, set its context to at least 64k,
   and start the local server.
2. From the Summer project root, get the exact loaded model ID:

   ```bash
   curl -fsS http://127.0.0.1:1234/v1/models
   ```

3. Configure both the LM Studio provider and Summer MCP in one command. Replace
   the example model ID with the `id` returned above:

   ```bash
   npx -y summer-engine@latest setup opencode --yes \
     --project "$PWD" \
     --lm-studio-model "google/gemma-4-26b-a4b-qat" \
     --lm-studio-vision \
     --json
   ```

When OpenCode setup receives `--project` and no explicit `--scope`, it writes
`./opencode.json`. The generated config:

- selects the loaded LM Studio model through its OpenAI-compatible endpoint;
- declares image input when `--lm-studio-vision` is present, allowing OpenCode
  to pass Summer screenshot results to a vision-capable model;
- uses a 131k context and disables hidden reasoning by default so small local
  models do not spend their output budget before calling a tool;
- starts Summer MCP with the complete tool registry and an absolute project
  binding;
- preserves unrelated OpenCode providers, models, plugins, and MCP servers.

When testing a local npm tarball, use the local package name rather than the
published `@latest` spec:

```bash
npm install --save-dev ./summer-engine-2.7.0.tgz
npx summer setup opencode --yes \
  --project "$PWD" \
  --lm-studio-model "google/gemma-4-26b-a4b-qat" \
  --lm-studio-vision \
  --local-dev \
  --json
```

The project must have its own `package.json`. The generated MCP command will
point at that installed candidate instead of an npx cache or
`summer-engine@latest`.

## OpenCode with any existing model provider

If OpenCode already has a working model provider, configure only Summer MCP:

```bash
npx -y summer-engine@latest setup opencode --yes \
  --project "$PWD" \
  --json
```

Use `--scope user` explicitly if one Summer MCP entry should be shared by all
OpenCode projects. Keep `--project` even for user scope so scene tools bind to
the intended Summer editor.

## Verify before changing a scene

After restarting OpenCode in the project, use this first prompt:

> Call `summer_get_agent_playbook` and read the result. Then call
> `summer_get_project_context` and inspect my scene without changing it. Report
> the MCP server version, bound project, scene root, and any diagnostics. Do not claim
> success unless those Summer tools returned results.

Only after that succeeds should the model mutate the scene. For a reversible
smoke test, ask it to add one uniquely named node, inspect it, run the project,
capture editor and game screenshots, check diagnostics, then remove that node
and verify cleanup.

## Manual MCP-only `opencode.json`

If the CLI cannot write the config, start with this provider-neutral shape:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "summer-engine": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "summer-engine@latest",
        "mcp",
        "--project",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

This is the complete OpenCode MCP setup; no provider block is required.

## Manual optional OpenCode + LM Studio recipe

Use this larger shape only when you explicitly want Summer setup to also add an
LM Studio provider. Replace both the model ID and project path. OpenCode
requires the MCP command as an array.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "lmstudio/google/gemma-4-26b-a4b-qat",
  "small_model": "lmstudio/google/gemma-4-26b-a4b-qat",
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio (local)",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1"
      },
      "models": {
        "google/gemma-4-26b-a4b-qat": {
          "name": "google/gemma-4-26b-a4b-qat (local)",
          "limit": {
            "context": 131072,
            "output": 8192
          },
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "options": {
            "reasoningEffort": "none"
          }
        }
      }
    }
  },
  "mcp": {
    "summer-engine": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "summer-engine@latest",
        "mcp",
        "--project",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

## Troubleshooting

| Symptom | Check |
|---|---|
| LM Studio model is missing | `curl -fsS http://127.0.0.1:1234/v1/models` must return its exact ID. |
| Summer tools are missing | Restart OpenCode, then inspect `opencode debug config` and `opencode mcp list`. |
| Tools exist but scene calls fail | Open the same project in Summer Engine and confirm the absolute `--project` path. |
| Model talks about tools but never calls them | Use a model trained for multi-turn tool use, raise its context to at least 64k, enable only the Summer integration for the first test, and require playbook/context results before mutation. |
| Screenshot is returned but OpenCode says the model cannot see it | Re-run setup with `--lm-studio-vision` only if the loaded model actually accepts image input, then restart OpenCode. |
| LM Studio reports `Unknown ArrayValue filter: upper` or `Unknown test: sequence` | The model's embedded Jinja tool template is incompatible with that LM Studio runtime. In **My Models → gear → Inference → Prompt Template**, replace it with the model package's bundled `chat_template.jinja`, restart OpenCode, and retry the playbook prompt. Use **Reset** to restore the prior template. |
| `npx` is not found | Put the absolute path from `command -v npx` in the MCP command array. |

The optional npm plugin is separate from MCP. OpenCode discovers installed
Summer skills from its standard `.opencode/skills`, `.claude/skills`, or
`.agents/skills` locations; the MCP server itself exposes
`summer_get_agent_playbook` for clients that do not load skills.
