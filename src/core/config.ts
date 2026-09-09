import { readStoreJson, writeStoreJson } from "./store.js";

const CONFIG_FILE = "config.json";
const DEFAULT_GATEWAY_URL = "https://www.summerengine.com";
const DEFAULT_CREATOR_API_URL = "https://summercraft.ai";

export interface SummerConfig {
  schemaVersion: 1;
  gateway?: {
    url?: string;
  };
  creator?: {
    apiUrl?: string;
    projectId?: string;
    channel?: string;
  };
}

export const CONFIG_KEYS = [
  "gateway.url",
  "creator.apiUrl",
  "creator.projectId",
  "creator.channel",
] as const;

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
    parsed.hostname === "::1";
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

function validateCreatorApiUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      'creator.apiUrl must be a complete URL. Recovery: use "summer config set creator.apiUrl https://summercraft.ai".'
    );
  }
  const local =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error(
      "creator.apiUrl must use HTTPS (HTTP is allowed only for localhost). Recovery: set an HTTPS URL and retry."
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "creator.apiUrl must be an origin without credentials, a path, query parameters, or fragments."
    );
  }
  return parsed.origin;
}

function validateValue(key: ConfigKey, value: string): string {
  const clean = value.trim();
  if (!clean) {
    throw new Error(
      `Cannot set ${key} to an empty value. Recovery: provide a value, or run "summer config unset ${key}".`
    );
  }
  if (key === "gateway.url") return validateGatewayUrl(clean);
  if (key === "creator.apiUrl") return validateCreatorApiUrl(clean);
  if (key === "creator.channel" && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(clean)) {
    throw new Error(
      "creator.channel may contain letters, numbers, dots, underscores, and hyphens. Recovery: choose a channel such as production or preview."
    );
  }
  if (key === "creator.projectId" && clean.length > 128) {
    throw new Error(
      "creator.projectId is too long. Recovery: copy the project ID from the Summer creator dashboard and retry."
    );
  }
  return clean;
}

export function getConfigValue(
  config: SummerConfig,
  key: ConfigKey
): string | undefined {
  if (key === "gateway.url") return config.gateway?.url;
  if (key === "creator.apiUrl") return config.creator?.apiUrl;
  if (key === "creator.projectId") return config.creator?.projectId;
  return config.creator?.channel;
}

export async function setConfigValue(
  key: ConfigKey,
  rawValue: string
): Promise<SummerConfig> {
  const config = await readSummerConfig();
  const value = validateValue(key, rawValue);
  if (key === "gateway.url") {
    config.gateway = { ...config.gateway, url: value };
  } else if (key === "creator.apiUrl") {
    config.creator = { ...config.creator, apiUrl: value };
  } else if (key === "creator.projectId") {
    config.creator = { ...config.creator, projectId: value };
  } else {
    config.creator = { ...config.creator, channel: value };
  }
  await writeStoreJson(CONFIG_FILE, config);
  return config;
}

export async function unsetConfigValue(key: ConfigKey): Promise<SummerConfig> {
  const config = await readSummerConfig();
  if (key === "gateway.url" && config.gateway) delete config.gateway.url;
  if (key === "creator.apiUrl" && config.creator) delete config.creator.apiUrl;
  if (key === "creator.projectId" && config.creator) {
    delete config.creator.projectId;
  }
  if (key === "creator.channel" && config.creator) delete config.creator.channel;
  if (config.gateway && Object.keys(config.gateway).length === 0) {
    delete config.gateway;
  }
  if (config.creator && Object.keys(config.creator).length === 0) {
    delete config.creator;
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

export async function getCreatorApiUrl(): Promise<string> {
  const config = await readSummerConfig();
  return config.creator?.apiUrl ?? DEFAULT_CREATOR_API_URL;
}
