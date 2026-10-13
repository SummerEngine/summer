import { readStoreJson, writeStoreJson } from "./store.js";

const CONFIG_FILE = "config.json";
const DEFAULT_GATEWAY_URL = "https://www.summerengine.com";

export interface SummerConfig {
  schemaVersion: 1;
  gateway?: {
    url?: string;
  };
}

export const CONFIG_KEYS = ["gateway.url"] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

function emptyConfig(): SummerConfig {
  return { schemaVersion: 1 };
}

export async function readSummerConfig(): Promise<SummerConfig> {
  const value = await readStoreJson<SummerConfig>(CONFIG_FILE);
  if (!value) return emptyConfig();
  if (value.schemaVersion !== 1) {
    throw new Error(
      `Unsupported ~/.summer/config.json schema ${String(value.schemaVersion)}. Recovery: upgrade the Summer CLI, or move config.json aside and configure it again.`
    );
  }
  return value;
}

function validateGatewayUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `gateway.url must be a complete URL. Recovery: use "summer config set gateway.url https://www.summerengine.com".`
    );
  }
  const local =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error(
      "gateway.url must use HTTPS (HTTP is allowed only for localhost). Recovery: set an HTTPS URL and retry."
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "gateway.url cannot contain credentials, query parameters, or fragments. Recovery: set only the origin URL and retry."
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function validateValue(key: ConfigKey, value: string): string {
  const clean = value.trim();
  if (!clean) {
    throw new Error(
      `Cannot set ${key} to an empty value. Recovery: provide a value, or run "summer config unset ${key}".`
    );
  }
  return validateGatewayUrl(clean);
}

export function getConfigValue(
  config: SummerConfig,
  key: ConfigKey
): string | undefined {
  return config.gateway?.url;
}

export async function setConfigValue(
  key: ConfigKey,
  rawValue: string
): Promise<SummerConfig> {
  const config = await readSummerConfig();
  const value = validateValue(key, rawValue);
  config.gateway = { ...config.gateway, url: value };
  await writeStoreJson(CONFIG_FILE, config);
  return config;
}

export async function unsetConfigValue(key: ConfigKey): Promise<SummerConfig> {
  const config = await readSummerConfig();
  if (config.gateway) delete config.gateway.url;
  if (config.gateway && Object.keys(config.gateway).length === 0) {
    delete config.gateway;
  }
  await writeStoreJson(CONFIG_FILE, config);
  return config;
}

export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}

/**
 * The ONE gateway base URL for every Summer gateway call: login, generation,
 * asset search/get, job polling, telemetry, and library feedback all resolve
 * through here so a token minted against one gateway is never posted to
 * another. Precedence: SUMMER_GATEWAY_URL env > ~/.summer/config.json
 * gateway.url > production. Resolved at CALL time (never at import) so a
 * config change is seen by every caller in the same process, and validated on
 * every read: HTTPS only, except plain HTTP to loopback for local development.
 * Returns an origin-like base without a trailing slash.
 */
export async function resolveGatewayUrl(): Promise<string> {
  const environment = process.env.SUMMER_GATEWAY_URL?.trim();
  if (environment) return validateGatewayUrl(environment);
  const config = await readSummerConfig();
  const configured = config.gateway?.url?.trim();
  return configured ? validateGatewayUrl(configured) : DEFAULT_GATEWAY_URL;
}
