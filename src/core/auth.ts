import {
  SummerStoreError,
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

/**
 * credential-metadata.json is ADVISORY: everything in it is re-derivable from
 * the JWT (see getCredentialMetadata's fallback), so unparseable contents are
 * treated as an empty document and rewritten on the next save. It must never
 * strand a valid token behind an "Already logged in" that cannot be used.
 * Unsafe files (symlink/directory) and unreadable stores still fail: those are
 * the store's security contract, not a stale-content problem.
 */
async function readMetadata(): Promise<CredentialMetadataDocument> {
  try {
    return (
      (await readStoreJson<CredentialMetadataDocument>(METADATA_FILE)) ?? {
        schemaVersion: 1,
      }
    );
  } catch (error) {
    if (error instanceof SummerStoreError && error.code === "invalid_store_json") {
      return { schemaVersion: 1 };
    }
    throw error;
  }
}

async function updateMetadata(
  kind: "auth" | "creator",
  value: CredentialMetadata | undefined,
  current?: CredentialMetadataDocument
): Promise<void> {
  current ??= await readMetadata();
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
  if (hasEnvAuthToken()) return process.env.SUMMER_TOKEN!.trim();
  const token = await readStoreText(AUTH_TOKEN_FILE);
  return token?.trim() || null;
}

/**
 * True when SUMMER_TOKEN (env) is the credential in effect. `summer logout`
 * only clears the store, so status/logout must say the env token still
 * applies rather than reporting the stored identity as the active one.
 */
export function hasEnvAuthToken(): boolean {
  return Boolean(process.env.SUMMER_TOKEN?.trim());
}

export async function saveAuthToken(
  token: string,
  scopes: string[] = []
): Promise<void> {
  const clean = token.trim();
  if (!clean) throw new Error("Cannot save an empty auth token.");
  // Read (and so validate) the metadata document BEFORE the token goes live:
  // a metadata file the store refuses must fail the login while nothing has
  // been written, not after auth-token already exists.
  const metadata = await readMetadata();
  await writeStoreText(AUTH_TOKEN_FILE, `${clean}\n`);
  await updateMetadata("auth", decodeJwtMetadata(clean, scopes), metadata);
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
  // Write order: user.json, then auth-token, then the advisory metadata. The
  // desktop engine cross-checks token.sub against user.json's id
  // (summerengine auth_manager.cpp, inspect_cli_bootstrap_credential), so a
  // write interrupted between the first two files fails closed instead of
  // adopting a mismatched identity. The metadata write is last and is NOT a
  // gate: the token is already live by then, and its contents are re-derived
  // from the JWT whenever the file is missing or unparseable.
  await saveUserInfo(session.user);
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
