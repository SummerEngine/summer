import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readStoreJson, writeStoreJson } from "./store.js";
import { readJsonResponse } from "./util/http.js";

/**
 * The Summer store sign-in for local tools (summer_publish_build): OAuth 2.1
 * authorization code + PKCE against the same Supabase authorization server
 * and resource the hosted MCP uses (mcp.summerengine.com/mcp), with a
 * loopback redirect (RFC 8252) and dynamic client registration. The access
 * token's audience is the MCP resource, the one token the creator store is
 * meant to accept for agents (creator publishing spec, part C.3).
 *
 * Stored in ~/.summer/oauth-token (0600) with its refresh token, separate
 * from the CLI JWT in auth-token: the engine reads that file and expects the
 * summer-cli contract.
 */

export const OAUTH_TOKEN_FILE = "oauth-token";
export const DEFAULT_MCP_RESOURCE_URL = "https://mcp.summerengine.com/mcp";
export const MCP_RESOURCE_ENV = "SUMMER_MCP_RESOURCE_URL";
const SCOPES = ["openid", "email", "offline_access"];
const REFRESH_MARGIN_MS = 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery: string
  ) {
    super(`${message} ${recovery}`);
    this.name = "OAuthError";
  }
}

export interface StoredOAuthToken {
  schemaVersion: 1;
  resource: string;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scope?: string;
}

interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

export interface OAuthDependencies {
  fetch: typeof fetch;
  now: () => number;
}

const defaultDependencies: OAuthDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: Date.now,
};

function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return !url.username && !url.password && (url.protocol === "https:" || (loopback && url.protocol === "http:"));
  } catch {
    return false;
  }
}

export function resolveMcpResourceUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[MCP_RESOURCE_ENV]?.trim() || DEFAULT_MCP_RESOURCE_URL;
  if (!isSafeUrl(value)) {
    throw new OAuthError(
      "oauth_resource_invalid",
      `${MCP_RESOURCE_ENV} must be an https URL (http only for localhost).`,
      `Recovery: unset ${MCP_RESOURCE_ENV} to use ${DEFAULT_MCP_RESOURCE_URL}.`
    );
  }
  return value;
}

async function getJson(deps: OAuthDependencies, url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await deps.fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const { json, parsed } = await readJsonResponse(response);
    return parsed && json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** RFC 9728 resource metadata, then RFC 8414 server metadata (path-aware first). */
export async function discoverAuthorizationServer(
  resource: string,
  deps: OAuthDependencies = defaultDependencies
): Promise<AuthorizationServer> {
  const resourceUrl = new URL(resource);
  const resourcePath = resourceUrl.pathname === "/" ? "" : resourceUrl.pathname.replace(/\/$/, "");
  const prm =
    (await getJson(deps, `${resourceUrl.origin}/.well-known/oauth-protected-resource${resourcePath}`)) ??
    (await getJson(deps, `${resourceUrl.origin}/.well-known/oauth-protected-resource`));
  const issuer = Array.isArray(prm?.authorization_servers) ? prm!.authorization_servers[0] : undefined;
  if (prm?.resource !== resource || typeof issuer !== "string" || !isSafeUrl(issuer)) {
    throw new OAuthError(
      "oauth_discovery_failed",
      `${resource} did not publish its sign-in server.`,
      "Recovery: check your network and retry; if it repeats, the hosted Summer MCP is not available yet."
    );
  }
  const issuerUrl = new URL(issuer);
  const issuerPath = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/, "");
  const metadata =
    (await getJson(deps, `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`)) ??
    (await getJson(deps, `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`)) ??
    (await getJson(deps, `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`));
  const endpoints = [metadata?.authorization_endpoint, metadata?.token_endpoint, metadata?.registration_endpoint];
  if (metadata?.issuer !== issuer || !endpoints.every((value) => typeof value === "string" && isSafeUrl(value))) {
    throw new OAuthError(
      "oauth_discovery_failed",
      `The sign-in server ${issuer} did not publish usable OAuth metadata.`,
      "Recovery: retry later; if it repeats, report the Summer sign-in server as unhealthy."
    );
  }
  return {
    issuer,
    authorizationEndpoint: endpoints[0] as string,
    tokenEndpoint: endpoints[1] as string,
    registrationEndpoint: endpoints[2] as string,
  };
}

async function postForm(
  deps: OAuthDependencies,
  url: string,
  form: Record<string, string>
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new OAuthError(
      "oauth_network_failed",
      `The sign-in server did not answer: ${error instanceof Error ? error.message : String(error)}.`,
      "Recovery: check your network and retry."
    );
  }
  const { json } = await readJsonResponse(response);
  const body = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  if (!response.ok) {
    const reason = typeof body.error === "string" ? body.error : `http_${response.status}`;
    throw new OAuthError(
      reason === "invalid_grant" ? "oauth_grant_invalid" : "oauth_token_refused",
      `The sign-in server refused the token request (${reason}).`,
      'Recovery: run "summer login --store --force" and approve access again.'
    );
  }
  return body;
}

function tokenFromResponse(
  body: Record<string, unknown>,
  base: Omit<StoredOAuthToken, "accessToken" | "refreshToken" | "expiresAt" | "scope">,
  now: number,
  previousRefresh?: string
): StoredOAuthToken {
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new OAuthError(
      "oauth_token_invalid",
      "The sign-in server returned no access token.",
      'Recovery: run "summer login --store --force" again.'
    );
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : previousRefresh;
  return {
    ...base,
    accessToken: body.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

interface Callback {
  redirectUri: string;
  code: Promise<string>;
  close: () => void;
}

/** A one-shot loopback listener on 127.0.0.1 for the authorization code. */
async function listenForCode(state: string, timeoutMs: number): Promise<Callback> {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  // An unawaited rejection (timeout before anyone awaits) must not crash the process.
  code.catch(() => undefined);
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const ok = !error && url.searchParams.get("state") === state && url.searchParams.get("code");
    response.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(
      ok
        ? "<!doctype html><title>Summer</title><p>Signed in to Summer. You can close this tab.</p>"
        : "<!doctype html><title>Summer</title><p>Sign-in did not finish. Return to the terminal.</p>"
    );
    if (ok) settle.resolve(url.searchParams.get("code")!);
    else
      settle.reject(
        new OAuthError(
          error === "access_denied" ? "oauth_access_denied" : "oauth_callback_invalid",
          error ? `Sign-in was not approved (${error}).` : "The sign-in answer did not match this login.",
          'Recovery: run "summer login --store" again and approve access.'
        )
      );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const timer = setTimeout(
    () =>
      settle.reject(
        new OAuthError(
          "oauth_timeout",
          `Sign-in did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`,
          'Recovery: run "summer login --store" again.'
        )
      ),
    timeoutMs
  );
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    code,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

export interface StoreLoginDependencies extends OAuthDependencies {
  openUrl: (url: string) => Promise<unknown>;
  log: (message: string) => void;
  timeoutMs?: number;
}

/** Browser sign-in (authorization code + PKCE) that stores ~/.summer/oauth-token. */
export async function runStoreLogin(deps: StoreLoginDependencies): Promise<StoredOAuthToken> {
  const resource = resolveMcpResourceUrl();
  const server = await discoverAuthorizationServer(resource, deps);
  const state = randomBytes(16).toString("base64url");
  const callback = await listenForCode(state, deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
  try {
    // A public client per login: the loopback port changes every time.
    let registration: Response;
    try {
      registration = await deps.fetch(server.registrationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "Summer CLI",
          redirect_uris: [callback.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: SCOPES.join(" "),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new OAuthError(
        "oauth_network_failed",
        `The sign-in server did not answer: ${error instanceof Error ? error.message : String(error)}.`,
        "Recovery: check your network and retry."
      );
    }
    const { json } = await readJsonResponse(registration);
    const clientId = (json as Record<string, unknown> | undefined)?.client_id;
    if (!registration.ok || typeof clientId !== "string" || !clientId) {
      throw new OAuthError(
        "oauth_registration_failed",
        `The sign-in server did not register the Summer CLI (${registration.status}).`,
        "Recovery: retry; if it repeats, report the Summer sign-in server as unhealthy."
      );
    }

    const { verifier, challenge } = pkce();
    const authorize = new URL(server.authorizationEndpoint);
    for (const [key, value] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback.redirectUri,
      scope: SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    })) {
      authorize.searchParams.set(key, value);
    }
    deps.log(`Approve Summer store access in your browser: ${authorize}`);
    try {
      await deps.openUrl(authorize.toString());
    } catch {
      deps.log("Could not open the browser. Copy the URL above and open it manually.");
    }

    const code = await callback.code;
    const now = deps.now();
    const body = await postForm(deps, server.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: callback.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    });
    const token = tokenFromResponse(
      body,
      { schemaVersion: 1, resource, issuer: server.issuer, tokenEndpoint: server.tokenEndpoint, clientId },
      now
    );
    await writeStoreJson(OAUTH_TOKEN_FILE, token);
    return token;
  } finally {
    callback.close();
  }
}

export async function readStoredOAuthToken(): Promise<StoredOAuthToken | null> {
  const token = await readStoreJson<StoredOAuthToken>(OAUTH_TOKEN_FILE).catch(() => null);
  return token && token.schemaVersion === 1 && typeof token.accessToken === "string" ? token : null;
}

/**
 * A current store access token: the stored one, refreshed when it expires
 * within a minute.
 */
export async function getStoreAccessToken(deps: OAuthDependencies = defaultDependencies): Promise<string> {
  const stored = await readStoredOAuthToken();
  if (!stored) {
    throw new OAuthError(
      "store_login_required",
      "This machine is not signed in to the Summer store.",
      'Recovery: run "summer login --store" in a terminal and approve access in the browser, then retry.'
    );
  }
  if (Date.parse(stored.expiresAt) - deps.now() > REFRESH_MARGIN_MS) return stored.accessToken;
  if (!stored.refreshToken) {
    throw new OAuthError(
      "store_login_expired",
      "The Summer store sign-in expired.",
      'Recovery: run "summer login --store --force", then retry.'
    );
  }
  const now = deps.now();
  const body = await postForm(deps, stored.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: stored.clientId,
    resource: stored.resource,
  });
  const { accessToken: _a, refreshToken: _r, expiresAt: _e, scope: _s, ...base } = stored;
  const next = tokenFromResponse(body, base, now, stored.refreshToken);
  await writeStoreJson(OAUTH_TOKEN_FILE, next);
  return next.accessToken;
}
