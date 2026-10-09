import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearAuthCredentials } from "./auth.js";
import {
  discoverAuthorizationServer,
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

let root = "";
beforeEach(async () => {
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
    const token = await runStoreLogin({ fetch: auth.fetch, now: () => clock, openUrl: auth.openUrl, log: () => undefined });
    const authorize = (auth.openUrl as any).authorize as URL;
    expect(authorize.searchParams.get("resource")).toBe(RESOURCE);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("scope")).toBe("openid email offline_access");
    expect(auth.registrations[0]).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: [authorize.searchParams.get("redirect_uri")] });
    expect(auth.registrations[0].redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
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
    await expect(runStoreLogin({ fetch: auth.fetch, now: Date.now, openUrl: auth.openUrl, log: () => undefined })).rejects.toMatchObject({
      code: "oauth_access_denied",
    });
    await expect(getStoreAccessToken({ fetch: auth.fetch, now: Date.now })).rejects.toBeInstanceOf(OAuthError);
    await expect(getStoreAccessToken({ fetch: auth.fetch, now: Date.now })).rejects.toMatchObject({ code: "store_login_required" });
  });
});
