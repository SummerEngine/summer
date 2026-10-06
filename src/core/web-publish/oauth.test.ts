import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readStoreJson, setSummerDirForTests, writeStoreJson } from "../store.js";
import {
  CLIENT_FILE,
  GamesAuthError,
  OAUTH_SCOPES,
  SUMMER_AUTH_ISSUER,
  TOKEN_FILE,
  createPkcePair,
  getGamesAccessToken,
  metadataUrl,
  runGamesLogin,
  type LoopbackServer,
  type StoredToken,
} from "./oauth.js";

const ISSUER = SUMMER_AUTH_ISSUER;
const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/clients/register`,
  code_challenge_methods_supported: ["S256"],
};

function jwt(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${enc({ alg: "ES256" })}.${enc(claims)}.sig`;
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-games-oauth-"));
  setSummerDirForTests(join(root, ".summer"));
});
afterEach(async () => {
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

function fakeServer(port: number, params: (authorizeUrl: string) => URLSearchParams) {
  let authorizeUrl = "";
  const server: LoopbackServer = {
    port,
    waitForCallback: async () => params(authorizeUrl),
    close: vi.fn(async () => {}),
  };
  return {
    server,
    setAuthorizeUrl: (url: string) => {
      authorizeUrl = url;
    },
  };
}

describe("PKCE and discovery", () => {
  it("derives an S256 challenge from a 43-char verifier", () => {
    const { verifier, challenge } = createPkcePair(() => Buffer.alloc(32, 7));
    expect(verifier).toHaveLength(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("builds the RFC 8414 metadata URL for a path issuer", () => {
    expect(metadataUrl(ISSUER)).toBe(
      "https://bjhcdenhsahdyirbbzlx.supabase.co/.well-known/oauth-authorization-server/auth/v1"
    );
  });
});

describe("runGamesLogin", () => {
  it("registers a public loopback client, sends PKCE, exchanges the code and stores the token", async () => {
    const accessToken = jwt({ sub: "user-1", email: "a@b.c", aud: "authenticated", exp: 4_000_000_000 });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const random = vi.fn((size: number) => Buffer.alloc(size, 1));
    const { server, setAuthorizeUrl } = fakeServer(53682, (authorizeUrl) => {
      const state = new URL(authorizeUrl).searchParams.get("state")!;
      return new URLSearchParams({ code: "the-code", state });
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === metadataUrl(ISSUER)) return Response.json(METADATA);
      if (url === METADATA.registration_endpoint) return Response.json({ client_id: "client-123" }, { status: 201 });
      if (url === METADATA.token_endpoint) {
        return Response.json({ access_token: accessToken, refresh_token: "r1", expires_in: 3600, token_type: "bearer" });
      }
      throw new Error(`unexpected ${url}`);
    });
    const token = await runGamesLogin({
      fetch: fetchMock as typeof fetch,
      openUrl: async (url) => setAuthorizeUrl(url),
      log: () => {},
      now: () => 1_000,
      randomBytes: random,
      listen: async (preferred) => {
        expect(preferred).toBeNull();
        return server;
      },
    });

    const registration = JSON.parse(String(calls[1]!.init!.body));
    expect(registration).toEqual({
      client_name: "Summer CLI",
      redirect_uris: ["http://127.0.0.1:53682/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPES,
    });
    const form = new URLSearchParams(String(calls[2]!.init!.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "http://127.0.0.1:53682/callback",
      client_id: "client-123",
      code_verifier: Buffer.alloc(32, 1).toString("base64url"),
    });
    expect(calls[2]!.init!.headers).toMatchObject({ "content-type": "application/x-www-form-urlencoded" });
    expect(token).toMatchObject({ clientId: "client-123", refreshToken: "r1", userId: "user-1", email: "a@b.c" });
    expect(await readStoreJson(TOKEN_FILE)).toMatchObject({ accessToken });
    expect(await readStoreJson(CLIENT_FILE)).toMatchObject({ clientId: "client-123" });
    expect(server.close).toHaveBeenCalled();
  });

  it("puts S256 PKCE, state, scope and redirect into the authorize URL and reuses a cached client", async () => {
    await writeStoreJson(CLIENT_FILE, {
      schemaVersion: 1,
      issuer: ISSUER,
      clientId: "cached",
      redirectUri: "http://127.0.0.1:50000/callback",
      registeredAt: "x",
    });
    let opened = "";
    const { server, setAuthorizeUrl } = fakeServer(50000, (url) => {
      const state = new URL(url).searchParams.get("state")!;
      return new URLSearchParams({ code: "c", state });
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === metadataUrl(ISSUER)) return Response.json(METADATA);
      if (url === METADATA.token_endpoint) return Response.json({ access_token: jwt({ sub: "u", exp: 4e9 }) });
      throw new Error(`unexpected ${url}`);
    });
    await runGamesLogin({
      fetch: fetchMock as typeof fetch,
      openUrl: async (url) => {
        opened = url;
        setAuthorizeUrl(url);
      },
      log: () => {},
      listen: async (preferred) => {
        expect(preferred).toBe(50000);
        return server;
      },
    });
    const params = new URL(opened).searchParams;
    expect(opened.startsWith(METADATA.authorization_endpoint)).toBe(true);
    expect(params.get("client_id")).toBe("cached");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe(OAUTH_SCOPES);
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:50000/callback");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(METADATA.registration_endpoint);
  });

  it("rejects a callback with a mismatched state before exchanging the code", async () => {
    const { server, setAuthorizeUrl } = fakeServer(1, () => new URLSearchParams({ code: "c", state: "evil" }));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === metadataUrl(ISSUER)) return Response.json(METADATA);
      if (url === METADATA.registration_endpoint) return Response.json({ client_id: "x" });
      throw new Error(`unexpected ${url}`);
    });
    await expect(
      runGamesLogin({
        fetch: fetchMock as typeof fetch,
        openUrl: async (url) => setAuthorizeUrl(url),
        log: () => {},
        listen: async () => server,
      })
    ).rejects.toMatchObject({ code: "games_auth_state_mismatch" });
  });

  it("maps a denied consent to games_auth_denied", async () => {
    const { server, setAuthorizeUrl } = fakeServer(1, (url) => {
      const state = new URL(url).searchParams.get("state")!;
      return new URLSearchParams({ error: "access_denied", state });
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === metadataUrl(ISSUER)) return Response.json(METADATA);
      return Response.json({ client_id: "x" });
    });
    await expect(
      runGamesLogin({
        fetch: fetchMock as typeof fetch,
        openUrl: async (url) => setAuthorizeUrl(url),
        log: () => {},
        listen: async () => server,
      })
    ).rejects.toMatchObject({ code: "games_auth_denied" });
  });

  it("refuses metadata that does not advertise S256", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ...METADATA, code_challenge_methods_supported: ["plain"] }));
    await expect(
      runGamesLogin({ fetch: fetchMock as typeof fetch, log: () => {}, listen: async () => fakeServer(1, () => new URLSearchParams()).server })
    ).rejects.toBeInstanceOf(GamesAuthError);
  });
});

describe("getGamesAccessToken", () => {
  const base: StoredToken = {
    schemaVersion: 1,
    issuer: ISSUER,
    clientId: "client-123",
    accessToken: "old",
    refreshToken: "r1",
    expiresAt: 10_000,
    userId: "u",
    email: null,
  };

  it("requires login when nothing is stored", async () => {
    await expect(getGamesAccessToken()).rejects.toMatchObject({ code: "games_login_required" });
  });

  it("returns a fresh token without network", async () => {
    await writeStoreJson(TOKEN_FILE, { ...base, expiresAt: 10_000_000 });
    const fetchMock = vi.fn();
    const token = await getGamesAccessToken({ fetch: fetchMock as unknown as typeof fetch, now: () => 0 });
    expect(token.accessToken).toBe("old");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token with the public client id and keeps the old refresh token if none is rotated", async () => {
    await writeStoreJson(TOKEN_FILE, base);
    const fresh = jwt({ sub: "u", exp: 5_000_000 });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === metadataUrl(ISSUER)) return Response.json(METADATA);
      expect(url).toBe(METADATA.token_endpoint);
      expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({
        grant_type: "refresh_token",
        refresh_token: "r1",
        client_id: "client-123",
      });
      return Response.json({ access_token: fresh });
    });
    const token = await getGamesAccessToken({ fetch: fetchMock as typeof fetch, now: () => 20_000 });
    expect(token.accessToken).toBe(fresh);
    expect(token.refreshToken).toBe("r1");
    expect(token.expiresAt).toBe(5_000_000_000);
  });

  it("drops the credential and asks for login when the refresh token is rejected", async () => {
    await writeStoreJson(TOKEN_FILE, base);
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input) === metadataUrl(ISSUER)
        ? Response.json(METADATA)
        : Response.json({ error: "invalid_grant" }, { status: 400 })
    );
    await expect(getGamesAccessToken({ fetch: fetchMock as typeof fetch, now: () => 20_000 })).rejects.toMatchObject({
      code: "games_login_expired",
    });
    expect(await readStoreJson(TOKEN_FILE)).toBeNull();
  });
});
