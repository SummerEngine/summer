import { Command } from "commander";
import { listCreatorReleases } from "../../core/capabilities/creator.js";

export const releasesCommand = new Command("releases")
  .description("List creator releases for a project")
  .option("--project-id <id>", "Creator project ID")
  .option("--limit <count>", "Maximum releases to return", "20")
  .option("--cursor <value>", "Opaque cursor returned by the previous page")
  .action(async (opts: { projectId?: string; limit: string; cursor?: string }) => {
    const limit = Number.parseInt(opts.limit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error(
        "--limit must be between 1 and 100. Recovery: pass a whole number in that range."
      );
    }
    const result = await listCreatorReleases({
      projectId: opts.projectId,
      limit,
      cursor: opts.cursor,
      face: "cli",
    });
    console.log(JSON.stringify(result, null, 2));
  });
