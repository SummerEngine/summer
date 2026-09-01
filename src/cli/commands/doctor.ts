import { createRequire } from "node:module";
import { Command } from "commander";
import { runDoctor } from "../../core/capabilities/doctor.js";
import { brandLine } from "../../core/format.js";

const require = createRequire(import.meta.url);
const { version } = require("../../../package.json") as { version: string };

export const doctorCommand = new Command("doctor")
  .description("Diagnose Node, login, engine, project memory, local API, and MCP registration")
  .option("--json", "Print diagnostics as JSON")
  .action(async (opts: { json?: boolean }) => {
    if (!opts.json) {
      console.log("");
      console.log(brandLine(version));
      console.log("");
    }
    const result = await runDoctor({ json: Boolean(opts.json) });
    if (!result.ok) {
      process.exit(1);
    }
  });
