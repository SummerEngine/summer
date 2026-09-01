import { Command } from "commander";
import { publishCreator } from "../../core/capabilities/creator.js";

export const publishCommand = new Command("publish")
  .description("Publish a confirmed creator release")
  .argument("[project]", "Project root. Defaults to the current directory.")
  .requiredOption("--artifact <path>", "Exact exported Summer .pck artifact")
  .requiredOption("--version <value>", "Immutable release version")
  .option("--manifest <path>", "Optional JSON release manifest")
  .option("--project-id <id>", "Creator project ID")
  .option("--channel <name>", "Release channel")
  .option("--notes <text>", "Release notes")
  .option(
    "--confirm",
    "Confirm the exact project and channel after reviewing them"
  )
  .action(
    async (
      project: string | undefined,
      opts: {
        artifact: string;
        version: string;
        manifest?: string;
        projectId?: string;
        channel?: string;
        notes?: string;
        confirm?: boolean;
      }
    ) => {
      const result = await publishCreator({
        project,
        ...opts,
        face: "cli",
      });
      console.log(JSON.stringify(result, null, 2));
    }
  );
