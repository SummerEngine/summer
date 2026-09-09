import { Command } from "commander";
import { runDoctor } from "../../core/capabilities/doctor.js";
import { brandLine } from "../../core/format.js";

import { TOOLKIT_VERSION as version } from "../../core/version.js";

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
