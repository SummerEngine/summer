import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import open from "open";
import {
  getDeveloperOAuthClientId,
  getDeveloperOAuthIssuer,
} from "./config.js";
import {
  readStoreJson,
  removeStoreFile,
  writeStoreJson,
} from "./store.js";

const PLATFORM_SESSION_FILE = "platform-session.json";
const CALLBACK_URL = "http://127.0.0.1:1455/oauth/callback";
const LOGIN_TIMEOUT_MS = 15 * 60_000;

interface OAuthDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface PlatformSession {
  schemaVersion: 1;
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
}

export interface PlatformLoginDependencies {
  fetch: typeof fetch;
  authorize: (url: string, state: string) => Promise<string>;
  randomBytes: (size: number) => Buffer;
  now: () => number;
  log: (message: string) => void;
}

async function browserAuthorization(url: string, expectedState: string): Promise<string> {
  const callback = new URL(CALLBACK_URL);
  let timer: NodeJS.Timeout | undefined;
  return new Promise<string>((resolvePromise, reject) => {
    let settled = false;
    const finish = (error?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close(() => {
        if (error) reject(error);
        else resolvePromise(code!);
      });
    };
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", CALLBACK_URL);
      if (request.method !== "GET" || requestUrl.pathname !== callback.pathname) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      const state = requestUrl.searchParams.get("state") ?? "";
      const stateMatches =
        state.length === expectedState.length &&
        timingSafeEqual(Buffer.from(state), Buffer.from(expectedState));
      const error = requestUrl.searchParams.get("error");
      const code = requestUrl.searchParams.get("code");
      if (!stateMatches || error || !code) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Summer sign-in was rejected. You can close this tab.");
        finish(
          new Error(
            error
              ? `Developer sign-in was rejected: ${error}.`
              : "Developer sign-in returned an invalid callback."
          )
        );
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Signed in to Summer. You can close this tab.");
      finish(undefined, code);
    });
    server.once("error", (error) => finish(error));
    server.listen(Number(callback.port), callback.hostname, async () => {
      try {
        await open(url);
      } catch {
        // The URL is printed by the command, so a headless user can open it.
      }
    });
    timer = setTimeout(
      () => finish(new Error('Developer sign-in timed out. Run "summer login --platform" again.')),
      LOGIN_TIMEOUT_MS
    );
    timer.unref();
  });
}

const defaultDependencies: PlatformLoginDependencies = {
  fetch,
  authorize: browserAuthorization,
  randomBytes,
  now: Date.now,
  log: console.log,
};

function endpoint(value: string, expectedOrigin: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`OAuth discovery returned an invalid ${name}.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== expectedOrigin ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`OAuth discovery returned an unsafe ${name}.`);
  }
  return parsed.toString();
}

async function discover(
  fetchImplementation: typeof fetch,
  issuer: string
): Promise<OAuthDiscovery> {
  const response = await fetchImplementation(
    `${issuer}/.well-known/openid-configuration`,
    { redirect: "error", signal: AbortSignal.timeout(10_000) }
  );
  if (!response.ok) {
    throw new Error(`Developer OAuth discovery failed (${response.status}).`);
  }
  const document = (await response.json()) as Partial<OAuthDiscovery>;
  if (
    document.issuer !== issuer ||
    typeof document.authorization_endpoint !== "string" ||
    typeof document.token_endpoint !== "string" ||
    !document.code_challenge_methods_supported?.includes("S256") ||
    !document.grant_types_supported?.includes("authorization_code") ||
    !document.grant_types_supported?.includes("refresh_token")
  ) {
    throw new Error("Developer OAuth discovery does not support the required PKCE and refresh contract.");
  }
  const origin = new URL(issuer).origin;
  return {
    ...document,
    issuer,
    authorization_endpoint: endpoint(
      document.authorization_endpoint,
      origin,
      "authorization endpoint"
    ),
    token_endpoint: endpoint(document.token_endpoint, origin, "token endpoint"),
  };
}

function decodePart(value: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("The developer identity provider returned a malformed access token.");
  }
}

function validateAccessToken(tokenValue: string, issuer: string, now: number): number {
  const parts = tokenValue.split(".");
  if (parts.length !== 3 || tokenValue.length > 16 * 1024) {
    throw new Error("The developer identity provider returned a malformed access token.");
  }
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  const audiences =
    typeof claims.aud === "string"
      ? [claims.aud]
      : Array.isArray(claims.aud)
        ? claims.aud
        : [];
  const expiresAt = typeof claims.exp === "number" ? claims.exp * 1000 : 0;
  const issuedAt = typeof claims.iat === "number" ? claims.iat * 1000 : 0;
  if (
    header.alg !== "ES256" ||
    claims.iss !== issuer ||
    audiences.length !== 1 ||
    audiences[0] !== "authenticated" ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0 ||
    claims.sub.length > 512 ||
    !issuedAt ||
    !expiresAt ||
    issuedAt > now + 30_000 ||
    expiresAt <= now ||
    expiresAt - issuedAt > 60 * 60_000
  ) {
    throw new Error("The developer access token does not match the Summer management credential contract.");
  }
  return expiresAt;
}

async function tokenRequest(
  deps: PlatformLoginDependencies,
  discovery: OAuthDiscovery,
  values: Record<string, string>
): Promise<OAuthTokenResponse> {
  const response = await deps.fetch(discovery.token_endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(values),
  });
  if (!response.ok) {
    throw new Error(`Developer OAuth token exchange failed (${response.status}).`);
  }
  const result = (await response.json()) as Partial<OAuthTokenResponse>;
  if (
    typeof result.access_token !== "string" ||
    result.access_token.length === 0 ||
    (result.token_type && result.token_type.toLowerCase() !== "bearer")
  ) {
    throw new Error("Developer OAuth returned an incomplete token response.");
  }
  return result as OAuthTokenResponse;
}

export async function runPlatformLogin(
  overrides: Partial<PlatformLoginDependencies> = {}
): Promise<void> {
  const deps = { ...defaultDependencies, ...overrides };
  const issuer = await getDeveloperOAuthIssuer();
  const clientId = await getDeveloperOAuthClientId();
  if (!clientId) {
    throw new Error(
      'No Summer developer OAuth client is configured. Set the registered public client with "summer config set platform.oauthClientId <client-id>" and retry.'
    );
  }
  const discovery = await discover(deps.fetch, issuer);
  const verifier = deps.randomBytes(48).toString("base64url");
  const state = deps.randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL(discovery.authorization_endpoint);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", CALLBACK_URL);
  authorization.searchParams.set("scope", "openid email profile");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  deps.log(`Sign in at: ${authorization.toString()}`);
  const code = await deps.authorize(authorization.toString(), state);
  const tokenResult = await tokenRequest(deps, discovery, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: CALLBACK_URL,
  });
  const expiresAt = validateAccessToken(tokenResult.access_token, issuer, deps.now());
  await writeStoreJson(PLATFORM_SESSION_FILE, {
    schemaVersion: 1,
    issuer,
    clientId,
    accessToken: tokenResult.access_token,
    ...(tokenResult.refresh_token ? { refreshToken: tokenResult.refresh_token } : {}),
    expiresAt: new Date(expiresAt).toISOString(),
  } satisfies PlatformSession);
  deps.log("Developer platform sign-in complete.");
}

async function refreshSession(
  session: PlatformSession,
  overrides: Partial<PlatformLoginDependencies> = {}
): Promise<PlatformSession> {
  if (!session.refreshToken) {
    throw new Error('Developer sign-in expired. Run "summer login --platform" again.');
  }
  const deps = { ...defaultDependencies, ...overrides };
  const discovery = await discover(deps.fetch, session.issuer);
  const result = await tokenRequest(deps, discovery, {
    grant_type: "refresh_token",
    client_id: session.clientId,
    refresh_token: session.refreshToken,
  });
  const expiresAt = validateAccessToken(result.access_token, session.issuer, deps.now());
  const next: PlatformSession = {
    ...session,
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? session.refreshToken,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  await writeStoreJson(PLATFORM_SESSION_FILE, next);
  return next;
}

export async function getManagementToken(
  overrides: Partial<PlatformLoginDependencies> = {}
): Promise<string> {
  const environment = process.env.SUMMER_MANAGEMENT_TOKEN?.trim();
  if (environment) return environment;
  const session = await readStoreJson<PlatformSession>(PLATFORM_SESSION_FILE);
  if (
    !session ||
    session.schemaVersion !== 1 ||
    typeof session.issuer !== "string" ||
    typeof session.clientId !== "string" ||
    typeof session.accessToken !== "string"
  ) {
    throw new Error('No developer platform session exists. Run "summer login --platform" first.');
  }
  const deps = { ...defaultDependencies, ...overrides };
  const expectedIssuer = await getDeveloperOAuthIssuer();
  const expectedClientId = await getDeveloperOAuthClientId();
  if (
    session.issuer !== expectedIssuer ||
    (expectedClientId !== null && session.clientId !== expectedClientId)
  ) {
    throw new Error('The stored developer session does not match current configuration. Run "summer login --platform --force".');
  }
  try {
    const expiresAt = validateAccessToken(
      session.accessToken,
      session.issuer,
      deps.now()
    );
    if (expiresAt - deps.now() > 60_000) return session.accessToken;
  } catch {
    // A refresh below is the only recovery for an expired or malformed token.
  }
  return (await refreshSession(session, deps)).accessToken;
}

export async function hasPlatformSession(): Promise<boolean> {
  return (await readStoreJson<PlatformSession>(PLATFORM_SESSION_FILE)) !== null;
}

export async function clearPlatformSession(): Promise<boolean> {
  return removeStoreFile(PLATFORM_SESSION_FILE);
}

export const platformOAuthCallbackUrl = CALLBACK_URL;
