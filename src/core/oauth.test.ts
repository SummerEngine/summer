import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAuthCredentials } from "./auth.js";
import {
  discoverAuthorizationServer,
  STORE_LOGIN_PORTS,
  getStoreAccessToken,
  OAuthError,
  readStoredOAuthToken,
  runStoreLogin,
} from "./oauth.js";
import { getSummerDir, setSummerDirForTests } from "./store.js";

const RESOURCE = "https://mcp.summerengine.com/mcp";
const ISSUER = "https://auth.test/auth/v1";

/** The hosted MCP's resource metadata and a Supabase-shaped OAuth server. */
function fakeAuthServer(options: { redirectError?: string } = {}) {
  const forms: Array<Record<string, string>> = [];
  const registrations: any[] = [];
  let issued = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "https://mcp.summerengine.com/.well-known/oauth-protected-resource/mcp") {
      return json({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["openid", "email", "offline_access"] });
    }
    if (url === "https://auth.test/.well-known/oauth-authorization-server/auth/v1") {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        registration_endpoint: `${ISSUER}/oauth/clients/register`,
      });
    }
    if (url === `${ISSUER}/oauth/clients/register`) {
      registrations.push(JSON.parse(String(init.body)));
      return json({ client_id: "client-1" }, 201);
    }
    if (url === `${ISSUER}/oauth/token`) {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      forms.push(form);
      if (form.grant_type === "refresh_token" && form.refresh_token !== "refresh-1") return json({ error: "invalid_grant" }, 400);
      issued += 1;
      return json({ access_token: `access-${issued}`, refresh_token: form.grant_type === "refresh_token" ? undefined : "refresh-1", expires_in: 3600, token_type: "bearer" });
    }
    return json({}, 404);
  }) as typeof globalThis.fetch;

  /** Plays the browser: approves, then follows the redirect to the loopback listener. */
  const openUrl = async (authorizeUrl: string) => {
    const url = new URL(authorizeUrl);
    const redirect = new URL(url.searchParams.get("redirect_uri")!);
    if (options.redirectError) redirect.searchParams.set("error", options.redirectError);
    else redirect.searchParams.set("code", "code-1");
    redirect.searchParams.set("state", url.searchParams.get("state")!);
    (openUrl as any).authorize = url;
    setTimeout(() => request(redirect, (response) => response.resume()).end(), 10);
  };
  return { fetch, openUrl, forms, registrations };
}

/** Free loopback ports for one test (the real fixed ports may be taken on a CI host). */
async function freePorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  for (let i = 0; i < count; i += 1) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
  }
  const ports = servers.map((server) => (server.address() as { port: number }).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

async function occupy(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

let root = "";
let ports: number[] = [];
beforeEach(async () => {
  ports = await freePorts(3);
  root = await mkdtemp(join(tmpdir(), "summer-oauth-test-"));
  setSummerDirForTests(join(root, ".summer"));
});
afterEach(async () => {
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

describe("store OAuth sign-in", () => {
  it("discovers the authorization server from the MCP resource", async () => {
    const server = await discoverAuthorizationServer(RESOURCE, { fetch: fakeAuthServer().fetch, now: Date.now });
    expect(server).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/oauth/authorize`,
      tokenEndpoint: `${ISSUER}/oauth/token`,
      registrationEndpoint: `${ISSUER}/oauth/clients/register`,
    });
  });

  it("signs in with PKCE on a loopback redirect, stores the token, then refreshes it", async () => {
    const auth = fakeAuthServer();
    let clock = Date.parse("2026-10-09T00:00:00Z");
    const token = await runStoreLogin({ fetch: auth.fetch, now: () => clock, openUrl: auth.openUrl, log: () => undefined, ports });
    const authorize = (auth.openUrl as any).authorize as URL;
    expect(authorize.searchParams.get("resource")).toBe(RESOURCE);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toBe("openid email offline_access");
    // One public client, registered for exactly the fixed loopback redirects.
    expect(auth.registrations[0]).toMatchObject({
      token_endpoint_auth_method: "none",
      redirect_uris: ports.map((port) => `http://127.0.0.1:${port}/callback`),
    });
    expect(authorize.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${ports[0]}/callback`);
    expect(auth.forms[0]).toMatchObject({ grant_type: "authorization_code", code: "code-1", client_id: "client-1", resource: RESOURCE });
    expect(auth.forms[0]!.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1", clientId: "client-1", resource: RESOURCE });
    if (process.platform !== "win32") {
      expect((await stat(join(getSummerDir(), "oauth-token"))).mode & 0o777).toBe(0o600);
    }

    expect(await getStoreAccessToken({ fetch: auth.fetch, now: () => clock })).toBe("access-1");
    clock += 3600_000;
    expect(await getStoreAccessToken({ fetch: auth.fetch, now: () => clock })).toBe("access-2");
    expect(auth.forms[1]).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "client-1" });
    // The refresh answer had no new refresh token: the old one is kept.
    expect(await readStoredOAuthToken()).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-1" });

    expect(await clearAuthCredentials()).toBeGreaterThanOrEqual(1);
    expect(await readStoredOAuthToken()).toBeNull();
  });

  it("fails clearly when access is denied or no sign-in exists", async () => {
    const auth = fakeAuthServer({ redirectError: "access_denied" });
    await expect(runStoreLogin({ fetch: auth.fetch, now: Date.now, openUrl: auth.openUrl, log: () => undefined, ports })).rejects.toMatchObject({
      code: "oauth_access_denied",
    });
    await expect(getStoreAccessToken({ fetch: auth.fetch, now: Date.now })).rejects.toBeInstanceOf(OAuthError);
    await expect(getStoreAccessToken({ fetch: auth.fetch, now: Date.now })).rejects.toMatchObject({ code: "store_login_required" });
  });
});

describe("the Summer CLI OAuth client", () => {
  const login = (auth: ReturnType<typeof fakeAuthServer>, extra: { newClient?: boolean } = {}) =>
    runStoreLogin({ fetch: auth.fetch, now: Date.now, openUrl: auth.openUrl, log: () => undefined, ports, ...extra });

  it("ships fixed loopback ports", () => {
    expect([...STORE_LOGIN_PORTS]).toEqual([47615, 47616, 47617]);
  });

  it("registers once per machine and reuses that client on every later login", async () => {
    const auth = fakeAuthServer();
    await login(auth);
    await login(auth);
    expect(auth.registrations).toHaveLength(1);
    expect(auth.forms.map((form) => form.client_id)).toEqual(["client-1", "client-1"]);
  });

  it("registers a new client only when asked (--force)", async () => {
    const auth = fakeAuthServer();
    await login(auth);
    await login(auth, { newClient: true });
    expect(auth.registrations).toHaveLength(2);
  });

  it("uses the next fixed port when the first is busy", async () => {
    const busy = await occupy(ports[0]!);
    try {
      const auth = fakeAuthServer();
      await login(auth);
      const authorize = (auth.openUrl as any).authorize as URL;
      expect(authorize.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${ports[1]}/callback`);
      expect(auth.forms[0]).toMatchObject({ redirect_uri: `http://127.0.0.1:${ports[1]}/callback` });
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
  });

  it("fails clearly when every fixed port is busy, before registering anything", async () => {
    const busy = await Promise.all(ports.map(occupy));
    try {
      const auth = fakeAuthServer();
      await expect(login(auth)).rejects.toMatchObject({ code: "oauth_ports_busy" });
      expect(auth.registrations).toHaveLength(0);
    } finally {
      await Promise.all(busy.map((server) => new Promise((resolve) => server.close(resolve))));
    }
  });

  it("does not reuse a client registered for other redirects", async () => {
    const auth = fakeAuthServer();
    await login(auth);
    ports = await freePorts(3);
    await login(auth);
    expect(auth.registrations).toHaveLength(2);
  });
});
