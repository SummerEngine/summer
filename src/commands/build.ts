import { Command } from "commander";
import { publishBuild } from "../lib/build-publish.js";

export const buildCommand = new Command("build").description(
  "Create hosted game server Builds through the Summer platform"
);

buildCommand
  .command("publish")
  .description(
    "Package source, seal and publish a BuildPublication draft, then wait for platform workers"
  )
  .argument("[project]", "Archive root containing summer.build.json. Defaults to the current directory.")
  .requiredOption("--version <value>", "Immutable Build version")
  .option("--no-wait", "Return after the draft is queued instead of waiting for the immutable Build")
  .action(
    async (
      project: string | undefined,
      opts: { version: string; wait: boolean }
    ) => {
      const result = await publishBuild({
        project,
        version: opts.version,
        wait: opts.wait,
      });
      console.log(JSON.stringify(result, null, 2));
    }
  );
