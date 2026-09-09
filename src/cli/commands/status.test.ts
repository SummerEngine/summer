import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveAuthToken, saveUserInfo } from "../../core/auth.js";
import { setConfigValue } from "../../core/config.js";
import { setSummerDirForTests, writeStoreText } from "../../core/store.js";
import { runLogout } from "./logout.js";
import { runStatus } from "./status.js";

let root = "";
const originalToken = process.env.SUMMER_TOKEN;
const originalGateway = process.env.SUMMER_GATEWAY_URL;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-status-test-"));
  setSummerDirForTests(join(root, ".summer"));
  delete process.env.SUMMER_TOKEN;
  delete process.env.SUMMER_GATEWAY_URL;
});

afterEach(async () => {
  setSummerDirForTests(null);
  if (originalToken === undefined) delete process.env.SUMMER_TOKEN;
  else process.env.SUMMER_TOKEN = originalToken;
  if (originalGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = originalGateway;
  await rm(root, { recursive: true, force: true });
});

async function statusLines(): Promise<string[]> {
  const lines: string[] = [];
  await runStatus((message) => lines.push(message));
  return lines;
}

describe("summer status auth line", () => {
  it("reports SUMMER_TOKEN as the credential in effect, not the stored identity", async () => {
    await saveAuthToken("file-token");
    await saveUserInfo({ id: "user-1", email: "stored@example.com" });
    process.env.SUMMER_TOKEN = "env-token";

    const lines = await statusLines();
    expect(lines).toContain("  Auth: SUMMER_TOKEN (env) — logout does not affect it");
    expect(lines.join("\n")).not.toContain("stored@example.com");
  });

  it("stays up when user.json is corrupt", async () => {
    await saveAuthToken("file-token");
    await writeStoreText("user.json", "{not json");

    const auth = (await statusLines()).find((line) => line.startsWith("  Auth:"));
    expect(auth).toMatch(/Logged in \(identity unreadable: .*not valid JSON/);
  });

  it("points a signed-out user at the npx login hint and the configured gateway", async () => {
    await setConfigValue("gateway.url", "https://staging.example");

    const lines = await statusLines();
    expect(lines).toContain("        Run: npx -y summer-engine@latest login");
    expect(lines).toContain("        Or: https://staging.example/login");
    expect(lines.join("\n")).not.toContain("npx summer-engine");
  });
});

describe("summer logout with SUMMER_TOKEN", () => {
  it("says the env token still applies", async () => {
    await saveAuthToken("file-token");
    process.env.SUMMER_TOKEN = "env-token";

    const lines: string[] = [];
    await runLogout((message) => lines.push(message));
    expect(lines[0]).toBe("Logged out. Stored auth tokens cleared.");
    expect(lines[1]).toContain("SUMMER_TOKEN is set");
    expect(lines[1]).toContain("logout does not affect it");
  });
});
