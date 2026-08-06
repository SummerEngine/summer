import { Command } from "commander";
import {
  configureAgentMcp,
  parseAgent,
  resolveAgentConfigScope,
  supportedAgents,
} from "../lib/agent-config.js";
import { startMcpServer } from "../mcp/server.js";

export const mcpCommand = new Command("mcp")
  .description("Start the MCP server for AI tool integration (Cursor, Claude Code, etc.)")
  .option(
    "--project <path>",
    "Bind local engine tools to the editor running this project"
  )
  .option(
    "--instance <id>",
    "Bind local engine tools to one exact Summer editor instance"
  )
  .action(async (opts: { project?: string; instance?: string }) => {
    await startMcpServer({
      projectPath: opts.project,
      instanceId: opts.instance,
    });
  });

mcpCommand
  .command("setup <agent>")
  .description("Configure an AI agent to use the Summer Engine MCP server")
  .option(
    "--scope <scope>",
    "Configuration scope: user or project (OpenCode + --project defaults to project)"
  )
  .option("--print", "Print the MCP config snippet instead of writing files")
  .option("--dry-run", "Show planned changes without writing files")
  .option("--local-dev", "Use the local built CLI instead of npx summer-engine")
  .option("--project <path>", "Bind the MCP server entry to one Summer project")
  .option(
    "--lm-studio-model <id>",
    "Configure OpenCode to use this loaded LM Studio model ID"
  )
  .option(
    "--lm-studio-url <url>",
    "LM Studio OpenAI-compatible base URL",
    "http://127.0.0.1:1234/v1"
  )
  .option(
    "--lm-studio-vision",
    "Declare image input support for a vision-capable LM Studio model"
  )
  .option("--json", "Print the setup result as JSON")
  .action(
    async (
      agentValue: string,
      opts: {
        scope?: string;
        print?: boolean;
        dryRun?: boolean;
        localDev?: boolean;
        project?: string;
        lmStudioModel?: string;
        lmStudioUrl?: string;
        lmStudioVision?: boolean;
        json?: boolean;
      }
    ) => {
      const agent = parseAgent(agentValue);
      if (!agent) {
        throw new Error(`Unsupported agent. Use one of: ${supportedAgents.join(", ")}`);
      }

      const projectPath = opts.project ?? mcpCommand.opts().project;
      const scope = resolveAgentConfigScope(agent, opts.scope, projectPath);
      if (!scope) {
        throw new Error("Invalid --scope. Use user or project.");
      }
      if (opts.lmStudioModel && agent !== "opencode") {
        throw new Error("--lm-studio-model is only supported with `summer mcp setup opencode`.");
      }

      const result = await configureAgentMcp({
        agent,
        scope,
        print: opts.print,
        dryRun: opts.dryRun,
        localDev: opts.localDev,
        projectPath,
        opencodeLmStudio: opts.lmStudioModel
          ? {
              modelId: opts.lmStudioModel,
              baseUrl: opts.lmStudioUrl,
              vision: opts.lmStudioVision,
            }
          : undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.print) {
        console.log(result.snippet.trimEnd());
      } else if (result.dryRun) {
        console.log(`Would update ${result.path} for ${result.agent} (${result.scope}).`);
        console.log(result.snippet.trimEnd());
      } else if (result.wrote) {
        console.log(
          `Configured Summer Engine MCP for ${result.agent} (${result.scope}) at ${result.path}.`
        );
      } else {
        console.log(
          `Summer Engine MCP already configured for ${result.agent} (${result.scope}) at ${result.path}.`
        );
      }

      for (const warning of result.warnings) {
        console.warn(`Warning: ${warning}`);
      }

      if (!result.print && !result.dryRun) {
        console.log(result.nextSteps[result.nextSteps.length - 1]);
      }
    }
  );
