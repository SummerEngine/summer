import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Imported BEFORE any config is written: the gateway must be resolved when the
// beacon fires, not captured at module load.
import { _resetTelemetryPingedForTests, recordMcpSession } from "./telemetry.js";
import { saveAuthToken } from "./auth.js";
import { setConfigValue } from "./config.js";
import { setSummerDirForTests } from "./store.js";

let root = "";
const originalGateway = process.env.SUMMER_GATEWAY_URL;
const originalToken = process.env.SUMMER_TOKEN;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-telemetry-test-"));
  setSummerDirForTests(join(root, ".summer"));
  delete process.env.SUMMER_GATEWAY_URL;
  delete process.env.SUMMER_TOKEN;
  _resetTelemetryPingedForTests();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  setSummerDirForTests(null);
  if (originalGateway === undefined) delete process.env.SUMMER_GATEWAY_URL;
  else process.env.SUMMER_GATEWAY_URL = originalGateway;
  if (originalToken === undefined) delete process.env.SUMMER_TOKEN;
  else process.env.SUMMER_TOKEN = originalToken;
  await rm(root, { recursive: true, force: true });
});

/** The beacon is fire-and-forget (two store reads + fetch); wait for it. */
async function flush(seen: string[]): Promise<void> {
  const deadline = Date.now() + 2000;
  while (seen.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("recordMcpSession gateway resolution", () => {
  it("posts to the configured gateway.url, resolved at call time", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      seen.push(String(input));
      return new Response("{}", { status: 200 });
    });
    await saveAuthToken("file-token");
    await setConfigValue("gateway.url", "https://staging.example");

    recordMcpSession();
    await flush(seen);

    expect(seen).toEqual(["https://staging.example/api/mcp/log-local-call"]);
  });

  it("lets SUMMER_GATEWAY_URL win over config", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      seen.push(String(input));
      return new Response("{}", { status: 200 });
    });
    await saveAuthToken("file-token");
    await setConfigValue("gateway.url", "https://staging.example");
    process.env.SUMMER_GATEWAY_URL = "https://gateway.example/";

    recordMcpSession();
    await flush(seen);

    expect(seen).toEqual(["https://gateway.example/api/mcp/log-local-call"]);
  });
});
