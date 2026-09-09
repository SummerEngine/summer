import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAuthToken, saveAuthToken } from "./auth.js";
import { setSummerDirForTests } from "./store.js";

let root = "";
const originalToken = process.env.SUMMER_TOKEN;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-auth-env-test-"));
  setSummerDirForTests(join(root, ".summer"));
  delete process.env.SUMMER_TOKEN;
});

afterEach(async () => {
  setSummerDirForTests(null);
  if (originalToken === undefined) delete process.env.SUMMER_TOKEN;
  else process.env.SUMMER_TOKEN = originalToken;
  await rm(root, { recursive: true, force: true });
});

// Contract documented in library/skills/running-in-the-cloud/SKILL.md: a
// headless agent sets SUMMER_TOKEN instead of running a browser login, and the
// override is process-local (never written to disk).
describe("SUMMER_TOKEN override for the gateway credential", () => {
  it("falls back to ~/.summer/auth-token when the env var is unset", async () => {
    expect(await getAuthToken()).toBeNull();
    await saveAuthToken("file-token");
    expect(await getAuthToken()).toBe("file-token");
  });

  it("wins over the stored file when set", async () => {
    await saveAuthToken("file-token");
    process.env.SUMMER_TOKEN = "env-token";
    expect(await getAuthToken()).toBe("env-token");
  });

  it("is trimmed like the file value", async () => {
    process.env.SUMMER_TOKEN = "  env-token\n";
    expect(await getAuthToken()).toBe("env-token");
  });

  it("treats an empty or whitespace-only value as unset", async () => {
    process.env.SUMMER_TOKEN = "";
    expect(await getAuthToken()).toBeNull();
    process.env.SUMMER_TOKEN = "   ";
    expect(await getAuthToken()).toBeNull();
    await saveAuthToken("file-token");
    expect(await getAuthToken()).toBe("file-token");
  });

  it("never touches the store", async () => {
    process.env.SUMMER_TOKEN = "env-token";
    expect(await getAuthToken()).toBe("env-token");
    await expect(readdir(join(root, ".summer"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
