import { Command } from "commander";
import { createInterface } from "node:readline/promises";

import { GamesAuthError } from "../../core/web-publish/oauth.js";
import {
  CONTENT_RATINGS,
  WebPublishError,
  publishWebGame,
  type PublishWebGameInput,
  type PublishWebGameResult,
} from "../../core/web-publish/publish.js";
import { WebBuildError } from "../../core/web-publish/validate.js";

interface PublishWebOptions {
  game?: string;
  name?: string;
  description?: string;
  contentRating?: string;
  label?: string;
  submit: boolean;
  wait: string;
  confirm?: boolean;
  json?: boolean;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function printResult(result: PublishWebGameResult): void {
  console.log("");
  console.log(`Game:     ${result.gameId}${result.gameCreated ? " (new)" : ""}`);
  console.log(`Build:    ${result.versionId} — ${result.versionStatus}${result.rejectionReason ? ` (${result.rejectionReason})` : ""}`);
  console.log(`Review:   ${result.review.outcome} — ${result.review.detail}`);
  console.log(`Store:    ${result.storeUrl}`);
  if (result.playUrl) console.log(`Play URL: ${result.playUrl}`);
}

export const publishWebCommand = new Command("publish-web")
  .description("Publish an HTML5 web game (folder with index.html, or a .zip) to summer.games")
  .argument("<path>", "Web build folder containing index.html, or a .zip of it")
  .option("--game <gameId>", "Existing summer.games game id (game_...) to update")
  .option("--name <name>", "Store name; creates the game (or reuses yours with this exact name)")
  .option("--description <text>", "Store description for a new game")
  .option("--content-rating <rating>", `Content rating, one of ${CONTENT_RATINGS.join(", ")}`)
  .option("--label <text>", "Version label shown in your creator history", "")
  .option("--no-submit", "Upload the build without submitting the listing for review")
  .option("--wait <seconds>", "Seconds to wait for server-side processing", "600")
  .option("--confirm", "Skip the interactive confirmation (the target was already reviewed)")
  .option("--json", "Print the machine-readable result")
  .action(async (path: string, opts: PublishWebOptions) => {
    const waitSeconds = Number.parseInt(opts.wait, 10);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) {
      throw new Error("--wait must be a whole number of seconds between 0 and 3600.");
    }
    const input: PublishWebGameInput = {
      path,
      gameId: opts.game,
      name: opts.name,
      description: opts.description,
      contentRating: opts.contentRating,
      label: opts.label,
      submit: opts.submit,
      waitSeconds,
      confirm: opts.confirm,
      face: "cli",
    };
    try {
      let result: PublishWebGameResult;
      try {
        result = await publishWebGame(input, opts.json ? {} : { log: (m) => console.log(m) });
      } catch (error) {
        const interactive = process.stdin.isTTY && process.stdout.isTTY && !opts.json;
        if (!(error instanceof WebPublishError && error.code === "publish_confirmation_required" && interactive)) throw error;
        console.log(error.message.replace(/ Recovery:.*$/, ""));
        if (!(await askYesNo("Publish now? [y/N] "))) {
          console.log("Cancelled. Nothing was uploaded.");
          return;
        }
        result = await publishWebGame({ ...input, confirm: true }, { log: (m) => console.log(m) });
      }
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else printResult(result);
    } catch (error) {
      if (opts.json && (error instanceof WebPublishError || error instanceof GamesAuthError || error instanceof WebBuildError)) {
        console.log(
          JSON.stringify(
            {
              ok: false,
              code: error.code,
              message: error.message,
              recovery: error.recovery,
              ...(error instanceof WebPublishError && error.details ? { details: error.details } : {}),
            },
            null,
            2
          )
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });
