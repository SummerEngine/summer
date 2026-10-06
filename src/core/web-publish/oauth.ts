/**
 * Summer Engine account sign-in for summer.games publishing.
 *
 * OAuth 2.1 authorization code + PKCE (S256) against the Supabase OAuth
 * server of the Summer Engine project, with a public client (token auth
 * method "none") registered through dynamic client registration and a
 * loopback redirect (RFC 8252 §7.3). The browser lands on the Summer consent
 * page (/oauth/consent on summerengine.com), the user approves, and Supabase
 * redirects back to http://127.0.0.1:<port>/callback with the code.
 *
 * Stored files (all in ~/.summer/, 0600 via the store):
 * - games-oauth-client.json — the registered client (no secret; public client)
 * - games-oauth-token.json  — access + refresh token for the management API
 *
 * The core auth-token (summer-cli JWT read by the desktop engine) is never
 * touched.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { readStoreJson, removeStoreFile, writeStoreJson } from "../store.js";

export const SUMMER_AUTH_ISSUER = "https://bjhcdenhsahdyirbbzlx.supabase.co/auth/v1";
export const OAUTH_SCOPES = "openid email offline_access";
export const CLIENT_FILE = "games-oauth-client.json";
export const TOKEN_FILE = "games-oauth-token.json";
const CLIENT_NAME = "Summer CLI";
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const REFRESH_SKEW_MS = 60_000;

export class GamesAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery: string
  ) {
    super(`${message} ${recovery}`);
    this.name = "GamesAuthError";
  }
}

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

export interface StoredClient {
  schemaVersion: 1;
  issuer: string;
  clientId: string;
  redirectUri: string;
  registeredAt: string;
}

export interface StoredToken {
  schemaVersion: 1;
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  userId: string | null;
  email: string | null;
}

export interface OAuthDependencies {
  fetch: typeof fetch;
  openUrl: (url: string) => Promise<unknown>;
  log: (message: string) => void;
  now: () => number;
  randomBytes: (size: number) => Buffer;
  /** Start the loopback listener; tests replace it. */
  listen: (preferredPort: number | null) => Promise<LoopbackServer>;
}

export interface LoopbackServer {
  port: number;
  /** Resolves with the callback query parameters. */
  waitForCallback: (timeoutMs: number) => Promise<URLSearchParams>;
  close: () => Promise<void>;
}

export function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function createPkcePair(random: (size: number) => Buffer = randomBytes): {
  verifier: string;
  challenge: string;
} {
  // 32 random bytes -> 43-char verifier (RFC 7636 §4.1 minimum length).
  const verifier = base64url(random(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function metadataUrl(issuer: string): string {
  // RFC 8414 §3: insert the well-known segment between host and path.
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

function assertSecureUrl(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new GamesAuthError(
      "games_auth_metadata_invalid",
      `The authorization server metadata has no ${label}.`,
      "Recovery: retry later; if it repeats, the Summer sign-in service is misconfigured."
    );
  }
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new GamesAuthError(
      "games_auth_metadata_invalid",
      `The authorization server ${label} is not HTTPS.`,
      "Recovery: do not sign in; report the Summer sign-in metadata as unsafe."
    );
  }
  return value;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => "");
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function discoverMetadata(
  issuer: string,
  deps: Pick<OAuthDependencies, "fetch">
): Promise<AuthServerMetadata> {
  let response: Response;
  try {
    response = await deps.fetch(metadataUrl(issuer), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new GamesAuthError(
      "games_auth_network_failed",
      `Cannot reach the Summer sign-in service: ${error instanceof Error ? error.message : String(error)}.`,
      "Recovery: check your network and retry."
    );
  }
  const body = await readJson(response);
  if (!response.ok || body.issuer !== issuer) {
    throw new GamesAuthError(
      "games_auth_metadata_invalid",
      `The Summer sign-in metadata is unavailable or names a different issuer (${response.status}).`,
      "Recovery: retry later; if it repeats, report the Summer OAuth server as misconfigured."
    );
  }
  const methods = Array.isArray(body.code_challenge_methods_supported)
    ? (body.code_challenge_methods_supported as string[])
    : [];
  if (!methods.includes("S256")) {
    throw new GamesAuthError(
      "games_auth_metadata_invalid",
      "The Summer sign-in service does not advertise PKCE S256.",
      "Recovery: do not sign in; report the Summer OAuth server configuration."
    );
  }
  return {
    issuer,
    authorization_endpoint: assertSecureUrl(body.authorization_endpoint, "authorization_endpoint"),
    token_endpoint: assertSecureUrl(body.token_endpoint, "token_endpoint"),
    registration_endpoint:
      body.registration_endpoint === undefined
        ? undefined
        : assertSecureUrl(body.registration_endpoint, "registration_endpoint"),
    code_challenge_methods_supported: methods,
  };
}

/** RFC 7591 registration body for a public loopback client. */
export function registrationRequest(redirectUri: string): Record<string, unknown> {
  return {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: OAUTH_SCOPES,
  };
}

export async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  deps: Pick<OAuthDependencies, "fetch" | "now">
): Promise<StoredClient> {
  if (!metadata.registration_endpoint) {
    throw new GamesAuthError(
      "games_auth_registration_unavailable",
      "The Summer sign-in service does not offer dynamic client registration.",
      "Recovery: report the Summer OAuth server configuration; the CLI cannot sign in without it."
    );
  }
  const response = await deps.fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(registrationRequest(redirectUri)),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.client_id !== "string" || !body.client_id) {
    const detail =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : `status ${response.status}`;
    throw new GamesAuthError(
      "games_auth_registration_failed",
      `Client registration was refused (${detail}).`,
      "Recovery: retry; if it repeats, check that dynamic registration and loopback redirects are enabled on the Summer OAuth server."
    );
  }
  const client: StoredClient = {
    schemaVersion: 1,
    issuer: metadata.issuer,
    clientId: body.client_id,
    redirectUri,
    registeredAt: new Date(deps.now()).toISOString(),
  };
  await writeStoreJson(CLIENT_FILE, client);
  return client;
}

export function buildAuthorizeUrl(
  metadata: AuthServerMetadata,
  client: StoredClient,
  challenge: string,
  state: string
): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    return part ? (JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function tokenAudience(token: string): string[] {
  const aud = decodeJwtClaims(token).aud;
  if (typeof aud === "string") return [aud];
  return Array.isArray(aud) ? aud.filter((v): v is string => typeof v === "string") : [];
}

function toStoredToken(
  body: Record<string, unknown>,
  client: StoredClient,
  previousRefresh: string | null,
  now: number
): StoredToken {
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new GamesAuthError(
      "games_auth_token_invalid",
      "The token endpoint returned no access token.",
      'Recovery: run "summer login --games --force" again.'
    );
  }
  const claims = decodeJwtClaims(body.access_token);
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
  const exp = typeof claims.exp === "number" ? claims.exp * 1000 : null;
  return {
    schemaVersion: 1,
    issuer: client.issuer,
    clientId: client.clientId,
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previousRefresh,
    expiresAt: exp ?? (expiresIn !== null ? now + expiresIn * 1000 : now + 3600_000),
    userId: typeof claims.sub === "string" ? claims.sub : null,
    email: typeof claims.email === "string" ? claims.email : null,
  };
}

async function postToken(
  metadata: AuthServerMetadata,
  form: Record<string, string>,
  deps: Pick<OAuthDependencies, "fetch">
): Promise<{ response: Response; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await deps.fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new GamesAuthError(
      "games_auth_network_failed",
      `The token request failed: ${error instanceof Error ? error.message : String(error)}.`,
      "Recovery: check your network and retry."
    );
  }
  return { response, body: await readJson(response) };
}

export async function exchangeCode(
  metadata: AuthServerMetadata,
  client: StoredClient,
  code: string,
  verifier: string,
  deps: Pick<OAuthDependencies, "fetch" | "now">
): Promise<StoredToken> {
  const { response, body } = await postToken(
    metadata,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
    },
    deps
  );
  if (!response.ok) {
    throw new GamesAuthError(
      "games_auth_exchange_failed",
      `The authorization code was refused (${typeof body.error === "string" ? body.error : response.status}).`,
      'Recovery: run "summer login --games --force" and approve the request again.'
    );
  }
  return toStoredToken(body, client, null, deps.now());
}

function defaultListen(preferredPort: number | null): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    let settle: ((params: URLSearchParams) => void) | null = null;
    let pending: URLSearchParams | null = null;
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      const ok = url.searchParams.has("code") && !url.searchParams.has("error");
      res
        .writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" })
        .end(
          ok
            ? "<!doctype html><title>Summer CLI</title><p>Signed in. You can close this tab and return to your terminal.</p>"
            : "<!doctype html><title>Summer CLI</title><p>Sign-in did not complete. Return to your terminal for details.</p>"
        );
      if (settle) settle(url.searchParams);
      else pending = url.searchParams;
    });
    const onError = (error: NodeJS.ErrnoException) => {
      if (preferredPort !== null && error.code === "EADDRINUSE") {
        server.removeListener("error", onError);
        defaultListen(null).then(resolve, reject);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(preferredPort ?? 0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        waitForCallback: (timeoutMs) =>
          new Promise((done, fail) => {
            if (pending) return done(pending);
            const timer = setTimeout(
              () =>
                fail(
                  new GamesAuthError(
                    "games_auth_timeout",
                    `Sign-in timed out after ${Math.round(timeoutMs / 60000)} minutes.`,
                    'Recovery: run "summer login --games" again and approve the request in the browser tab it opens.'
                  )
                ),
              timeoutMs
            );
            settle = (params) => {
              clearTimeout(timer);
              done(params);
            };
          }),
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const defaultDeps: OAuthDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  openUrl: async (url) => (await import("open")).default(url),
  log: console.log,
  now: Date.now,
  randomBytes,
  listen: defaultListen,
};

function portOf(redirectUri: string): number | null {
  try {
    const port = Number(new URL(redirectUri).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export async function readStoredClient(issuer: string): Promise<StoredClient | null> {
  const client = await readStoreJson<StoredClient>(CLIENT_FILE).catch(() => null);
  return client && client.schemaVersion === 1 && client.issuer === issuer && client.clientId ? client : null;
}

export async function readStoredToken(): Promise<StoredToken | null> {
  const token = await readStoreJson<StoredToken>(TOKEN_FILE).catch(() => null);
  return token && token.schemaVersion === 1 && token.accessToken ? token : null;
}

/**
 * Interactive browser sign-in. Reuses the cached client when its loopback port
 * can be bound again (Supabase matches redirect URIs exactly); otherwise binds
 * a random port and registers a new public client for it.
 */
export async function runGamesLogin(
  overrides: Partial<OAuthDependencies> = {},
  issuer: string = SUMMER_AUTH_ISSUER
): Promise<StoredToken> {
  const deps = { ...defaultDeps, ...overrides };
  const metadata = await discoverMetadata(issuer, deps);
  const cached = await readStoredClient(issuer);
  const server = await deps.listen(cached ? portOf(cached.redirectUri) : null);
  try {
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;
    const client =
      cached && cached.redirectUri === redirectUri
        ? cached
        : await registerClient(metadata, redirectUri, deps);
    const { verifier, challenge } = createPkcePair(deps.randomBytes);
    const state = base64url(deps.randomBytes(24));
    const authorizeUrl = buildAuthorizeUrl(metadata, client, challenge, state);
    deps.log("Sign in to your Summer Engine account to publish on summer.games:");
    deps.log(authorizeUrl);
    try {
      await deps.openUrl(authorizeUrl);
    } catch {
      deps.log("Could not open the browser. Copy the URL above and open it manually.");
    }
    deps.log("Waiting for approval in the browser...");
    const params = await server.waitForCallback(LOGIN_TIMEOUT_MS);
    if (params.get("state") !== state) {
      throw new GamesAuthError(
        "games_auth_state_mismatch",
        "The browser callback carried a different state value.",
        'Recovery: close other sign-in tabs and run "summer login --games --force" again.'
      );
    }
    const error = params.get("error");
    if (error) {
      throw new GamesAuthError(
        error === "access_denied" ? "games_auth_denied" : "games_auth_failed",
        `Sign-in was not approved (${error}${params.get("error_description") ? `: ${params.get("error_description")}` : ""}).`,
        'Recovery: run "summer login --games" again and choose Connect on the Summer consent page.'
      );
    }
    const code = params.get("code");
    if (!code) {
      throw new GamesAuthError(
        "games_auth_failed",
        "The browser callback carried no authorization code.",
        'Recovery: run "summer login --games --force" again.'
      );
    }
    const token = await exchangeCode(metadata, client, code, verifier, deps);
    await writeStoreJson(TOKEN_FILE, token);
    deps.log(`Signed in${token.email ? ` as ${token.email}` : ""} for summer.games publishing.`);
    return token;
  } finally {
    await server.close();
  }
}

/**
 * Return a non-expired access token, refreshing with the stored refresh token
 * when needed. Throws games_login_required when no usable credential exists.
 */
export async function getGamesAccessToken(
  overrides: Partial<Pick<OAuthDependencies, "fetch" | "now">> = {},
  issuer: string = SUMMER_AUTH_ISSUER
): Promise<StoredToken> {
  const deps = { ...defaultDeps, ...overrides };
  const stored = await readStoredToken();
  if (!stored || stored.issuer !== issuer) {
    throw new GamesAuthError(
      "games_login_required",
      "Publishing to summer.games needs a Summer Engine account sign-in.",
      'Recovery: run "summer login --games" once in a terminal and approve the request in the browser.'
    );
  }
  if (stored.expiresAt - REFRESH_SKEW_MS > deps.now()) return stored;
  if (!stored.refreshToken) {
    throw new GamesAuthError(
      "games_login_expired",
      "The summer.games sign-in expired and has no refresh token.",
      'Recovery: run "summer login --games --force".'
    );
  }
  const metadata = await discoverMetadata(issuer, deps);
  const client: StoredClient = (await readStoredClient(issuer)) ?? {
    schemaVersion: 1,
    issuer,
    clientId: stored.clientId,
    redirectUri: "",
    registeredAt: "",
  };
  const { response, body } = await postToken(
    metadata,
    { grant_type: "refresh_token", refresh_token: stored.refreshToken, client_id: stored.clientId },
    deps
  );
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      await removeStoreFile(TOKEN_FILE);
      throw new GamesAuthError(
        "games_login_expired",
        `The summer.games sign-in could not be refreshed (${typeof body.error === "string" ? body.error : response.status}).`,
        'Recovery: run "summer login --games" again.'
      );
    }
    throw new GamesAuthError(
      "games_auth_refresh_failed",
      `The token refresh failed (${response.status}).`,
      "Recovery: retry shortly; if it repeats, run \"summer login --games --force\"."
    );
  }
  const next = toStoredToken(body, { ...client, clientId: stored.clientId }, stored.refreshToken, deps.now());
  await writeStoreJson(TOKEN_FILE, next);
  return next;
}

export async function clearGamesCredentials(): Promise<number> {
  let removed = 0;
  for (const file of [TOKEN_FILE, CLIENT_FILE]) if (await removeStoreFile(file)) removed += 1;
  return removed;
}
