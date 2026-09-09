import { Command, Option } from "commander";
import {
  configureAgentMcp,
  parseAgent,
  parseScope,
  supportedAgents,
} from "../installer/agent-config.js";
import { startMcpServer } from "./server.js";

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

// Deprecated alias. `summer setup <agent>` (src/cli/commands/setup.ts) is the
// one setup path: the same configureAgentMcp() write plus skills + doctor.
// This stays for one release so existing docs/scripts keep working; it cannot
// delegate to the cli layer (contract §2: mcp never imports cli), so it calls
// the shared installer directly and says where to go.
mcpCommand
  .command("setup <agent>")
  .description("Deprecated alias of `summer setup <agent>`: write only the MCP config for an agent")
  .option("--scope <scope>", "Configuration scope: user or project", "user")
  .option("--print", "Print the MCP config snippet instead of writing files")
  .option("--dry-run", "Show planned changes without writing files")
  .addOption(
    // Contributor-only: point the config at this checkout's built CLI instead
    // of npx summer-engine. Hidden from the public surface; also honoured
    // when SUMMER_DEV=1 is set.
    new Option("--local-dev", "Use the local built CLI instead of npx summer-engine").hideHelp()
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
        json?: boolean;
      }
    ) => {
      const agent = parseAgent(agentValue);
      if (!agent) {
        throw new Error(`Unsupported agent. Use one of: ${supportedAgents.join(", ")}`);
      }

      const scope = parseScope(opts.scope);
      if (!scope) {
        throw new Error("Invalid --scope. Use user or project.");
      }

      const result = await configureAgentMcp({
        agent,
        scope,
        print: opts.print,
        dryRun: opts.dryRun,
        localDev: opts.localDev || process.env.SUMMER_DEV === "1",
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!opts.print) {
        console.warn(
          `Note: 'summer mcp setup' is deprecated; use 'summer setup ${agent}' (same MCP config, plus skills and doctor).`
        );
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
