import { Command } from "commander";
import { readCreatorLogs } from "../core/capabilities/creator.js";

export const logsCommand = new Command("logs")
  .description("Read creator runtime logs")
  .option("--project-id <id>", "Creator project ID")
  .option("--release <id>", "Restrict logs to one release")
  .option("--limit <count>", "Maximum log entries to return", "100")
  .action(
    async (opts: { projectId?: string; release?: string; limit: string }) => {
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error(
          "--limit must be between 1 and 1000. Recovery: pass a whole number in that range."
        );
      }
      await readCreatorLogs({
        projectId: opts.projectId,
        releaseId: opts.release,
        limit,
        face: "cli",
      });
    }
  );
