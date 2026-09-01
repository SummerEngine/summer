import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({
  getAuthToken: vi.fn(),
}));

import { getAuthToken } from "../auth.js";
import { setSummerDirForTests } from "../store.js";
import {
  _resetFeedbackSessionForTests,
  consumeFirstRunNotice,
  FIRST_RUN_NOTICE,
  getFeedbackSessionId,
  getInstallId,
  getToolkitVersion,
  isFeedbackDisabled,
  sendLibraryFeedback,
  type SendLibraryFeedbackInput,
} from "./client.js";

const mockedGetAuthToken = vi.mocked(getAuthToken);

let root: string;
let fetchMock: ReturnType<typeof vi.fn>;

function input(): SendLibraryFeedbackInput {
  return {
    reports: [{ entry_id: "skill/grappling-hook", outcome: "worked" }],
    engine_version: "4.6.1",
  };
}

function sentBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-feedback-"));
  setSummerDirForTests(join(root, ".summer"));
  _resetFeedbackSessionForTests();
  mockedGetAuthToken.mockReset();
  mockedGetAuthToken.mockResolvedValue(null);
  fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SUMMER_NO_TELEMETRY", "");
  vi.stubEnv("DO_NOT_TRACK", "");
  vi.stubEnv("SUMMER_GATEWAY_URL", "");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setSummerDirForTests(null);
  await rm(root, { recursive: true, force: true });
});

describe("kill switches", () => {
  it("SUMMER_NO_TELEMETRY=1 sends nothing and reports disabled", async () => {
    vi.stubEnv("SUMMER_NO_TELEMETRY", "1");
    expect(isFeedbackDisabled()).toBe(true);
    const result = await sendLibraryFeedback(input());
    expect(result).toEqual({ recorded: false, disabled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DO_NOT_TRACK=1 sends nothing and reports disabled", async () => {
    vi.stubEnv("DO_NOT_TRACK", "1");
    const result = await sendLibraryFeedback(input());
    expect(result).toEqual({ recorded: false, disabled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disabled sends never consume the first-run notice", async () => {
    vi.stubEnv("DO_NOT_TRACK", "1");
    await sendLibraryFeedback(input());
    vi.stubEnv("DO_NOT_TRACK", "");
    const result = await sendLibraryFeedback(input());
    expect(result.notice).toBe(FIRST_RUN_NOTICE);
  });
});

describe("first-run notice", () => {
  it("appears exactly once per machine", async () => {
    const first = await sendLibraryFeedback(input());
    expect(first.notice).toBe(FIRST_RUN_NOTICE);
    const second = await sendLibraryFeedback(input());
    expect(second.notice).toBeUndefined();
  });

  it("consumeFirstRunNotice persists a marker file", async () => {
    expect(await consumeFirstRunNotice()).toBe(true);
    expect(await consumeFirstRunNotice()).toBe(false);
    const marker = await readFile(
      join(root, ".summer", "feedback-first-run"),
      "utf8"
    );
    expect(marker.length).toBeGreaterThan(0);
  });
});

describe("anonymous vs authed payloads", () => {
  it("anonymous: no bearer header, install_id in body, persisted across calls", async () => {
    const result = await sendLibraryFeedback(input());
    expect(result.recorded).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>).Authorization
    ).toBeUndefined();
    const body = sentBody();
    expect(body.install_id).toMatch(/^[0-9a-f-]{36}$/);
    // Same install id on the next send.
    await sendLibraryFeedback(input());
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string) as {
      install_id: string;
    };
    expect(secondBody.install_id).toBe(body.install_id);
    expect(await getInstallId()).toBe(body.install_id);
  });

  it("authed: bearer header attached, no install_id in body", async () => {
    mockedGetAuthToken.mockResolvedValue("tok-123");
    await sendLibraryFeedback(input());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-123"
    );
    expect(sentBody().install_id).toBeUndefined();
  });

  it("body carries reports, engine_version, per-process session_id and toolkit_version", async () => {
    await sendLibraryFeedback(input());
    const body = sentBody();
    expect(body.reports).toEqual(input().reports);
    expect(body.engine_version).toBe("4.6.1");
    expect(body.session_id).toBe(getFeedbackSessionId());
    expect(body.toolkit_version).toBe(getToolkitVersion());
  });

  it("targets SUMMER_GATEWAY_URL override, default prod host otherwise", async () => {
    await sendLibraryFeedback(input());
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://www.summerengine.com/api/mcp/library-feedback"
    );
    vi.stubEnv("SUMMER_GATEWAY_URL", "https://staging.example.com/");
    await sendLibraryFeedback(input());
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://staging.example.com/api/mcp/library-feedback"
    );
  });

  it("auth-store errors fall back to anonymous instead of throwing", async () => {
    mockedGetAuthToken.mockRejectedValue(new Error("store broken"));
    const result = await sendLibraryFeedback(input());
    expect(result.recorded).toBe(true);
    expect(sentBody().install_id).toBeDefined();
  });
});

describe("failure silence", () => {
  beforeEach(async () => {
    // Consume the first-run notice so result shapes are exact-matchable.
    await consumeFirstRunNotice();
  });

  it("network failure returns recorded:true, queued:false and never throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await sendLibraryFeedback(input());
    expect(result).toEqual({ recorded: true, queued: false });
  });

  it("abort (timeout) is swallowed the same way", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
    const started = Date.now();
    const result = await sendLibraryFeedback(input());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toEqual({ recorded: true, queued: false });
  });

  it("passes a 1s abort signal to fetch", async () => {
    await sendLibraryFeedback(input());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("non-2xx response is honest: recorded:true, queued:false", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
    const result = await sendLibraryFeedback(input());
    expect(result).toEqual({ recorded: true, queued: false });
  });

  it("2xx response returns plain recorded:true (no queued key)", async () => {
    const result = await sendLibraryFeedback(input());
    expect(result.recorded).toBe(true);
    expect("queued" in result).toBe(false);
  });
});
