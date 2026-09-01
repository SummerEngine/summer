import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAuthCredentials,
  getAuthToken,
  getCredentialMetadata,
  getCreatorToken,
  getUserInfo,
  saveCreatorToken,
  saveLoginSession,
} from "./auth.js";
import {
  getConfigValue,
  getGatewayUrl,
  readSummerConfig,
  setConfigValue,
  unsetConfigValue,
} from "./config.js";
import {
  readStoreText,
  setSummerDirForTests,
  writeStoreText,
} from "./store.js";

let root = "";
const originalGateway = process.env.SUMMER_GATEWAY_URL;

function token(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
    "base64url"
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.test-signature`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-store-test-"));
  setSummerDirForTests(join(root, ".summer"));
  delete process.env.SUMMER_GATEWAY_URL;
});

afterEach(async () => {
  setSummerDirForTests(null);
  if (originalGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = originalGateway;
  await rm(root, { recursive: true, force: true });
});

describe("secure Summer store", () => {
  it("uses hardened directory/file modes and refuses credential symlinks", async () => {
    await writeStoreText("safe-token", "secret\n");
    if (process.platform !== "win32") {
      expect((await stat(join(root, ".summer"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, ".summer", "safe-token"))).mode & 0o777).toBe(
        0o600
      );
    }

    const outside = join(root, "outside");
    await writeStoreText("outside", "not-used");
    await rm(join(root, ".summer", "outside"));
    await writeStoreText("target", "target");
    await symlink(join(root, ".summer", "target"), outside);
    await symlink(outside, join(root, ".summer", "unsafe-token"));

    await expect(readStoreText("unsafe-token")).rejects.toMatchObject({
      code: "unsafe_store_file",
    });
  });

  it("keeps core-compatible auth files and records scope metadata without duplicating the secret", async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const jwt = token({
      sub: "user-1",
      email: "maker@example.com",
      type: "cli",
      aud: "summer-cli",
      iat: expires - 60,
      exp: expires,
    });

    await saveLoginSession({
      token: jwt,
      user: {
        id: "user-1",
        email: "maker@example.com",
      },
      scopes: ["mcp:assets:read"],
    });

    expect(await getAuthToken()).toBe(jwt);
    expect(await getUserInfo()).toEqual({
      id: "user-1",
      email: "maker@example.com",
    });
    expect(await getCredentialMetadata()).toMatchObject({
      auth: {
        audience: ["summer-cli"],
        tokenType: "cli",
        scopes: ["mcp:assets:read"],
      },
    });
    const metadata = await readFile(
      join(root, ".summer", "credential-metadata.json"),
      "utf8"
    );
    expect(metadata).not.toContain(jwt);
    await saveCreatorToken(`sc_${"a".repeat(43)}`);
    expect(await getCreatorToken()).toBe(`sc_${"a".repeat(43)}`);
    expect(await getAuthToken()).toBe(jwt);
    expect(await getCredentialMetadata()).toMatchObject({
      creator: {
        audience: ["summercraft-creator"],
        tokenType: "api",
        scopes: ["publish"],
      },
    });
    expect(
      await readFile(join(root, ".summer", "credential-metadata.json"), "utf8")
    ).not.toContain(`sc_${"a".repeat(43)}`);
    expect(await clearAuthCredentials()).toBeGreaterThan(0);
    expect(await getAuthToken()).toBeNull();
    expect(await getCreatorToken()).toBeNull();
  });

  it("rejects a token/user identity mismatch before writing shared auth files", async () => {
    await expect(
      saveLoginSession({
        token: token({
          sub: "other-user",
          type: "cli",
          aud: "summer-cli",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        user: { id: "user-1", email: "maker@example.com" },
      })
    ).rejects.toThrow(/mismatched identity/);
    expect(await getAuthToken()).toBeNull();
  });
});

describe("shared Summer config", () => {
  it("sets, lists, unsets, and resolves non-secret configuration", async () => {
    await setConfigValue("creator.projectId", "project-123");
    await setConfigValue("creator.channel", "preview");
    await setConfigValue("creator.apiUrl", "http://localhost:3000");
    await setConfigValue("gateway.url", "https://gateway.example/");

    const config = await readSummerConfig();
    expect(getConfigValue(config, "creator.projectId")).toBe("project-123");
    expect(getConfigValue(config, "creator.channel")).toBe("preview");
    expect(getConfigValue(config, "creator.apiUrl")).toBe(
      "http://localhost:3000"
    );
    expect(await getGatewayUrl()).toBe("https://gateway.example");

    await unsetConfigValue("creator.channel");
    expect(
      getConfigValue(await readSummerConfig(), "creator.channel")
    ).toBeUndefined();
  });

  it("allows local HTTP development but rejects insecure remote gateways", async () => {
    await setConfigValue("gateway.url", "http://localhost:3000");
    expect(await getGatewayUrl()).toBe("http://localhost:3000");
    await expect(
      setConfigValue("gateway.url", "http://gateway.example")
    ).rejects.toThrow(/must use HTTPS/);
    await expect(
      setConfigValue("creator.apiUrl", "https://api.example/path")
    ).rejects.toThrow(/must be an origin/);
  });
});
