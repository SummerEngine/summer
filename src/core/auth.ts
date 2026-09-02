import {
  getSummerDir,
  readStoreJson,
  readStoreText,
  removeStoreFile,
  writeStoreJson,
  writeStoreText,
} from "./store.js";

export { getSummerDir } from "./store.js";

const AUTH_TOKEN_FILE = "auth-token";
/** Written by v2 `summer login` for the removed Summer Cloud sync. Only ever removed now (logout). */
const LEGACY_CLOUD_TOKEN_FILE = "cloud-token";
const CREATOR_TOKEN_FILE = "creator-token";
const USER_FILE = "user.json";
const METADATA_FILE = "credential-metadata.json";

export interface SummerUserInfo {
  id: string;
  email: string;
  name?: string;
}

export interface CredentialMetadata {
  audience: string[];
  scopes: string[];
  tokenType?: string;
  issuedAt?: string;
  expiresAt?: string;
}

interface CredentialMetadataDocument {
  schemaVersion: 1;
  auth?: CredentialMetadata;
  creator?: CredentialMetadata;
}

export interface LoginSession {
  token: string;
  user?: SummerUserInfo;
  scopes?: string[];
}

function decodeJwtMetadata(
  token: string,
  explicitScopes: string[] = []
): CredentialMetadata {
  const payload = decodeJwtPayload(token);
  const aud = payload.aud;
  const audience =
    typeof aud === "string"
      ? [aud]
      : Array.isArray(aud)
        ? aud.filter((value): value is string => typeof value === "string")
        : [];
  const claimScopes =
    typeof payload.scope === "string"
      ? payload.scope.split(/\s+/)
      : Array.isArray(payload.scp)
        ? payload.scp.filter((value): value is string => typeof value === "string")
        : [];
  const scopes = [...new Set([...explicitScopes, ...claimScopes].filter(Boolean))].sort();
  const issuedAt =
    typeof payload.iat === "number"
      ? new Date(payload.iat * 1000).toISOString()
      : undefined;
  const expiresAt =
    typeof payload.exp === "number"
      ? new Date(payload.exp * 1000).toISOString()
      : undefined;

  return {
    audience,
    scopes,
    ...(typeof payload.type === "string" ? { tokenType: payload.type } : {}),
    ...(issuedAt ? { issuedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const encoded = token.split(".")[1];
    if (encoded) {
      return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
    }
  } catch {
    // Metadata is advisory only. The gateway verifies the signature.
  }
  return {};
}

async function readMetadata(): Promise<CredentialMetadataDocument> {
  return (
    (await readStoreJson<CredentialMetadataDocument>(METADATA_FILE)) ?? {
      schemaVersion: 1,
    }
  );
}

async function updateMetadata(
  kind: "auth" | "creator",
  value: CredentialMetadata | undefined
): Promise<void> {
  const current = await readMetadata();
  const next: CredentialMetadataDocument = {
    ...current,
    schemaVersion: 1,
    [kind]: value,
  };
  if (!next.auth) delete next.auth;
  if (!next.creator) delete next.creator;
  await writeStoreJson(METADATA_FILE, next);
}

/**
 * Gateway credential. SUMMER_TOKEN wins over ~/.summer/auth-token so a
 * headless/cloud agent can authenticate gateway features (asset search,
 * generation, releases) without a browser login. The env override never
 * touches the store: `summer login` still writes the file, and the desktop
 * engine keeps reading it. Local engine ops need neither — they authenticate
 * with the engine-minted ~/.summer/api-token (see core/engine.ts).
 */
export async function getAuthToken(): Promise<string | null> {
  const envToken = process.env.SUMMER_TOKEN?.trim();
  if (envToken) return envToken;
  const token = await readStoreText(AUTH_TOKEN_FILE);
  return token?.trim() || null;
}

export async function saveAuthToken(
  token: string,
  scopes: string[] = []
): Promise<void> {
  const clean = token.trim();
  if (!clean) throw new Error("Cannot save an empty auth token.");
  await writeStoreText(AUTH_TOKEN_FILE, `${clean}\n`);
  await updateMetadata("auth", decodeJwtMetadata(clean, scopes));
}

/**
 * Summercraft creator tokens are a separate credential audience from the
 * core-compatible Summer CLI JWT. Never store an sc_ token in auth-token:
 * the engine reads that file and expects the summer-cli JWT contract.
 */
export async function getCreatorToken(): Promise<string | null> {
  const token = await readStoreText(CREATOR_TOKEN_FILE);
  return token?.trim() || null;
}

export async function saveCreatorToken(token: string): Promise<void> {
  const clean = token.trim();
  if (!/^sc_[A-Za-z0-9_-]{32,}$/.test(clean)) {
    throw new Error(
      'That is not a Summercraft creator API token. Recovery: open /creator/settings/tokens, mint a token with the "publish" scope, and paste the complete one-time sc_ value.'
    );
  }
  await writeStoreText(CREATOR_TOKEN_FILE, `${clean}\n`);
  await updateMetadata("creator", {
    audience: ["summercraft-creator"],
    scopes: ["publish"],
    tokenType: "api",
  });
}

export async function getUserInfo(): Promise<SummerUserInfo | null> {
  return readStoreJson<SummerUserInfo>(USER_FILE);
}

export async function saveUserInfo(info: SummerUserInfo): Promise<void> {
  await writeStoreJson(USER_FILE, info);
}

export async function saveLoginSession(session: LoginSession): Promise<void> {
  const payload = decodeJwtPayload(session.token);
  if (
    !session.user ||
    typeof payload.sub !== "string" ||
    payload.sub !== session.user.id
  ) {
    throw new Error(
      'The gateway returned an incomplete or mismatched identity. Recovery: run "summer login --force" again; if it repeats, report the CLI login endpoint as unhealthy.'
    );
  }
  const metadata = decodeJwtMetadata(session.token, session.scopes);
  if (
    metadata.tokenType !== "cli" ||
    !metadata.audience.includes("summer-cli")
  ) {
    throw new Error(
      'The gateway returned a token that is not valid for the Summer CLI. Recovery: run "summer login --force" again after the gateway is updated.'
    );
  }
  if (metadata.expiresAt && Date.parse(metadata.expiresAt) <= Date.now()) {
    throw new Error(
      'The gateway returned an expired CLI token. Recovery: run "summer login --force" again; if it repeats, check the gateway clock and token issuer.'
    );
  }
  // Keep auth-token and user.json canonical: the desktop engine already reads
  // those exact files. credential-metadata.json adds audience/scope information
  // without changing or duplicating the secret.
  // Activate the new auth token last. The desktop engine cross-checks token.sub
  // against user.json, so an interrupted multi-file write fails closed instead
  // of adopting a mismatched identity.
  if (session.user) await saveUserInfo(session.user);
  await saveAuthToken(session.token, session.scopes);
}

export async function getCredentialMetadata(): Promise<CredentialMetadataDocument> {
  const metadata = await readMetadata();
  const token = await getAuthToken();
  const creatorToken = await getCreatorToken();
  return {
    schemaVersion: 1,
    ...(token
      ? { auth: metadata.auth ?? decodeJwtMetadata(token) }
      : {}),
    ...(creatorToken
      ? {
          creator: metadata.creator ?? {
            audience: ["summercraft-creator"],
            scopes: [],
            tokenType: "api",
          },
        }
      : {}),
  };
}

export async function clearAuthCredentials(): Promise<number> {
  let removed = 0;
  for (const file of [
    AUTH_TOKEN_FILE,
    LEGACY_CLOUD_TOKEN_FILE,
    CREATOR_TOKEN_FILE,
    USER_FILE,
    METADATA_FILE,
  ]) {
    if (await removeStoreFile(file)) removed += 1;
  }
  return removed;
}

export function assertCredentialScopes(
  metadata: CredentialMetadata | undefined,
  requiredScopes: string[]
): void {
  const missing = requiredScopes.filter(
    (scope) => !metadata?.scopes.includes(scope)
  );
  if (missing.length === 0) return;
  throw new Error(
    `This sign-in does not grant ${missing.join(", ")}. Recovery: run "summer login --force" after the platform enables scoped creator tokens, then retry.`
  );
}
