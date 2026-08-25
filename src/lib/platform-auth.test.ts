import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getManagementToken,
  platformOAuthCallbackUrl,
  runPlatformLogin,
} from "./platform-auth.js";
import { setSummerDirForTests, writeStoreJson } from "./store.js";

let root = "";
const originalIssuer = process.env.SUMMER_DEVELOPER_OAUTH_ISSUER;
const originalClient = process.env.SUMMER_DEVELOPER_OAUTH_CLIENT_ID;
const originalToken = process.env.SUMMER_MANAGEMENT_TOKEN;

function accessToken(now: number): string {
  return accessTokenWithWindow(now, now + 3600_000);
}

function accessTokenWithWindow(issuedAt: number, expiresAt: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString(
    "base64url"
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://identity.example/auth/v1",
      sub: "developer-subject",
      aud: "authenticated",
      iat: Math.floor(issuedAt / 1000),
      exp: Math.floor(expiresAt / 1000),
    })
  ).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-platform-auth-test-"));
  setSummerDirForTests(join(root, ".summer"));
  process.env.SUMMER_DEVELOPER_OAUTH_ISSUER =
    "https://identity.example/auth/v1";
  process.env.SUMMER_DEVELOPER_OAUTH_CLIENT_ID = "summer-public-cli";
  delete process.env.SUMMER_MANAGEMENT_TOKEN;
});

afterEach(async () => {
  setSummerDirForTests(null);
  if (originalIssuer === undefined) delete process.env.SUMMER_DEVELOPER_OAUTH_ISSUER;
  else process.env.SUMMER_DEVELOPER_OAUTH_ISSUER = originalIssuer;
  if (originalClient === undefined) delete process.env.SUMMER_DEVELOPER_OAUTH_CLIENT_ID;
  else process.env.SUMMER_DEVELOPER_OAUTH_CLIENT_ID = originalClient;
  if (originalToken === undefined) delete process.env.SUMMER_MANAGEMENT_TOKEN;
  else process.env.SUMMER_MANAGEMENT_TOKEN = originalToken;
  await rm(root, { recursive: true, force: true });
});

describe("developer platform OAuth", () => {
  it("uses public-client authorization code PKCE and stores the Supabase access token separately", async () => {
    const now = Date.parse("2026-08-25T10:00:00Z");
    const token = accessToken(now);
    const authorize = vi.fn(async (url: string, state: string) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("client_id")).toBe("summer-public-cli");
      expect(parsed.searchParams.get("redirect_uri")).toBe(platformOAuthCallbackUrl);
      expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
      expect(parsed.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(parsed.searchParams.get("state")).toBe(state);
      return "authorization-code";
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: "https://identity.example/auth/v1",
          authorization_endpoint: "https://identity.example/auth/v1/oauth/authorize",
          token_endpoint: "https://identity.example/auth/v1/oauth/token",
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      }
      if (url.endsWith("/oauth/token")) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("client_id")).toBe("summer-public-cli");
        expect(form.get("code")).toBe("authorization-code");
        expect(form.get("code_verifier")).toHaveLength(64);
        expect(form.get("redirect_uri")).toBe(platformOAuthCallbackUrl);
        return Response.json({
          access_token: token,
          refresh_token: "refresh-secret",
          token_type: "bearer",
          expires_in: 3600,
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    await runPlatformLogin({
      fetch: fetchMock as typeof fetch,
      authorize,
      randomBytes: (size) => Buffer.alloc(size, 7),
      now: () => now,
      log: () => undefined,
    });

    expect(authorize).toHaveBeenCalledOnce();
    expect(await getManagementToken({ now: () => now })).toBe(token);
    const sessionPath = join(root, ".summer", "platform-session.json");
    const raw = await readFile(sessionPath, "utf8");
    expect(raw).toContain("refresh-secret");
    expect(raw).not.toContain("auth-token");
    if (process.platform !== "win32") {
      expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the environment-token seam explicit for local and staging canaries", async () => {
    process.env.SUMMER_MANAGEMENT_TOKEN = "fixture-management-token";
    expect(await getManagementToken()).toBe("fixture-management-token");
  });

  it("refreshes a nearly expired developer session without changing credential audiences", async () => {
    const now = Date.parse("2026-08-25T10:00:00Z");
    const oldToken = accessTokenWithWindow(now - 3500_000, now + 50_000);
    const newToken = accessToken(now);
    await writeStoreJson("platform-session.json", {
      schemaVersion: 1,
      issuer: "https://identity.example/auth/v1",
      clientId: "summer-public-cli",
      accessToken: oldToken,
      refreshToken: "rotating-refresh-secret",
      expiresAt: new Date(now + 50_000).toISOString(),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: "https://identity.example/auth/v1",
          authorization_endpoint: "https://identity.example/auth/v1/oauth/authorize",
          token_endpoint: "https://identity.example/auth/v1/oauth/token",
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      }
      if (url.endsWith("/oauth/token")) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("rotating-refresh-secret");
        return Response.json({
          access_token: newToken,
          refresh_token: "next-refresh-secret",
          token_type: "bearer",
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });

    expect(
      await getManagementToken({
        fetch: fetchMock as typeof fetch,
        now: () => now,
      })
    ).toBe(newToken);
    expect(
      await readFile(join(root, ".summer", "platform-session.json"), "utf8")
    ).toContain("next-refresh-secret");
  });
});
