import { readStoreJson, writeStoreJson } from "./store.js";

const CONFIG_FILE = "config.json";
const DEFAULT_GATEWAY_URL = "https://www.summerengine.com";
const DEFAULT_CREATOR_API_URL = "https://summercraft.ai";
const DEFAULT_DEVELOPER_OAUTH_ISSUER =
  "https://bjhcdenhsahdyirbbzlx.supabase.co/auth/v1";

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
  platform?: {
    managementUrl?: string;
    oauthIssuer?: string;
    oauthClientId?: string;
  };
}

export const CONFIG_KEYS = [
  "gateway.url",
  "creator.apiUrl",
  "creator.projectId",
  "creator.channel",
  "platform.managementUrl",
  "platform.oauthIssuer",
  "platform.oauthClientId",
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

function validateOrigin(key: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be a complete URL.`);
  }
  const local =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error(
      `${key} must use HTTPS (HTTP is allowed only for localhost).`
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
      `${key} must be an origin without credentials, a path, query parameters, or fragments.`
    );
  }
  return parsed.origin;
}

function validateIssuer(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("platform.oauthIssuer must be a complete HTTPS URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "platform.oauthIssuer must be a complete HTTPS URL without credentials, query parameters, or fragments."
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
  if (key === "gateway.url") return validateGatewayUrl(clean);
  if (key === "creator.apiUrl") return validateCreatorApiUrl(clean);
  if (key === "platform.managementUrl") return validateOrigin(key, clean);
  if (key === "platform.oauthIssuer") return validateIssuer(clean);
  if (
    key === "platform.oauthClientId" &&
    !/^[A-Za-z0-9._~-]{8,256}$/.test(clean)
  ) {
    throw new Error("platform.oauthClientId is not a valid public OAuth client ID.");
  }
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
  if (key === "creator.channel") return config.creator?.channel;
  if (key === "platform.managementUrl") return config.platform?.managementUrl;
  if (key === "platform.oauthIssuer") return config.platform?.oauthIssuer;
  return config.platform?.oauthClientId;
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
  } else if (key === "creator.channel") {
    config.creator = { ...config.creator, channel: value };
  } else if (key === "platform.managementUrl") {
    config.platform = { ...config.platform, managementUrl: value };
  } else if (key === "platform.oauthIssuer") {
    config.platform = { ...config.platform, oauthIssuer: value };
  } else {
    config.platform = { ...config.platform, oauthClientId: value };
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
  if (key === "platform.managementUrl" && config.platform) {
    delete config.platform.managementUrl;
  }
  if (key === "platform.oauthIssuer" && config.platform) {
    delete config.platform.oauthIssuer;
  }
  if (key === "platform.oauthClientId" && config.platform) {
    delete config.platform.oauthClientId;
  }
  if (config.gateway && Object.keys(config.gateway).length === 0) {
    delete config.gateway;
  }
  if (config.creator && Object.keys(config.creator).length === 0) {
    delete config.creator;
  }
  if (config.platform && Object.keys(config.platform).length === 0) {
    delete config.platform;
  }
  await writeStoreJson(CONFIG_FILE, config);
  return config;
}

export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}

export async function getGatewayUrl(): Promise<string> {
  const environment = process.env.SUMMER_GATEWAY_URL?.trim();
  if (environment) return validateGatewayUrl(environment);
  const config = await readSummerConfig();
  return config.gateway?.url ?? DEFAULT_GATEWAY_URL;
}

export async function getCreatorApiUrl(): Promise<string> {
  const config = await readSummerConfig();
  return config.creator?.apiUrl ?? DEFAULT_CREATOR_API_URL;
}

export async function getManagementUrl(): Promise<string | null> {
  const environment = process.env.SUMMER_MANAGEMENT_URL?.trim();
  if (environment) return validateOrigin("SUMMER_MANAGEMENT_URL", environment);
  const config = await readSummerConfig();
  return config.platform?.managementUrl
    ? validateOrigin("platform.managementUrl", config.platform.managementUrl)
    : null;
}

export async function getDeveloperOAuthIssuer(): Promise<string> {
  const environment = process.env.SUMMER_DEVELOPER_OAUTH_ISSUER?.trim();
  if (environment) return validateIssuer(environment);
  const config = await readSummerConfig();
  return config.platform?.oauthIssuer
    ? validateIssuer(config.platform.oauthIssuer)
    : DEFAULT_DEVELOPER_OAUTH_ISSUER;
}

export async function getDeveloperOAuthClientId(): Promise<string | null> {
  const environment = process.env.SUMMER_DEVELOPER_OAUTH_CLIENT_ID?.trim();
  if (environment) return validateValue("platform.oauthClientId", environment);
  const config = await readSummerConfig();
  return config.platform?.oauthClientId
    ? validateValue("platform.oauthClientId", config.platform.oauthClientId)
    : null;
}
