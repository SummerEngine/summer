import { Command } from "commander";
import {
  CONFIG_KEYS,
  getConfigValue,
  isConfigKey,
  readSummerConfig,
  setConfigValue,
  unsetConfigValue,
} from "../../core/config.js";

function requireKey(value: string) {
  if (isConfigKey(value)) return value;
  throw new Error(
    `Unknown config key "${value}". Recovery: use one of ${CONFIG_KEYS.join(", ")}.`
  );
}

async function printConfig(json: boolean): Promise<void> {
  const config = await readSummerConfig();
  const values = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, getConfigValue(config, key) ?? null])
  );
  if (json) {
    console.log(JSON.stringify(values, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value ?? "(not set)"}`);
  }
}

export const configCommand = new Command("config")
  .description("Read or update the shared ~/.summer configuration")
  .option("--json", "Print all configuration as JSON")
  .action(async (opts: { json?: boolean }) => printConfig(Boolean(opts.json)));

configCommand
  .command("get")
  .description("Read one configuration value")
  .argument("<key>", `One of: ${CONFIG_KEYS.join(", ")}`)
  .action(async (rawKey: string) => {
    const key = requireKey(rawKey);
    const value = getConfigValue(await readSummerConfig(), key);
    if (value === undefined) {
      throw new Error(
        `${key} is not set. Recovery: run "summer config set ${key} <value>", or rely on the documented default.`
      );
    }
    console.log(value);
  });

configCommand
  .command("set")
  .description("Set one non-secret configuration value")
  .argument("<key>", `One of: ${CONFIG_KEYS.join(", ")}`)
  .argument("<value>")
  .action(async (rawKey: string, value: string) => {
    const key = requireKey(rawKey);
    await setConfigValue(key, value);
    console.log(`Set ${key}.`);
  });

configCommand
  .command("unset")
  .description("Remove one configuration override")
  .argument("<key>", `One of: ${CONFIG_KEYS.join(", ")}`)
  .action(async (rawKey: string) => {
    const key = requireKey(rawKey);
    await unsetConfigValue(key);
    console.log(`Unset ${key}.`);
  });
