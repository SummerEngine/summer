import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({
  getAuthToken: vi.fn(),
}));

import { getAuthToken } from "../auth.js";
import { setSummerDirForTests } from "../store.js";
import { TOOLKIT_VERSION } from "../version.js";
import {
  _resetFeedbackSessionForTests,
  consumeFirstRunNotice,
  dropReasonForStatus,
  FEEDBACK_FIELDS_SENT,
  FIRST_RUN_NOTICE,
  getFeedbackSessionId,
  getInstallId,
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
    agent_model: "claude-fable-5",
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

describe("first-run notice (CONTRACT §10: notice BEFORE the first event)", () => {
  it("the first call on a machine sends NOTHING and returns first_run + notice; the second call sends", async () => {
    const first = await sendLibraryFeedback(input());
    expect(first).toEqual({ recorded: false, first_run: true, notice: FIRST_RUN_NOTICE });
    expect(fetchMock).not.toHaveBeenCalled();
    const second = await sendLibraryFeedback(input());
    expect(second).toEqual({ recorded: true });
    expect(second.notice).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the notice discloses every field the POST carries and tells the agent nothing was sent", async () => {
    const { notice } = await sendLibraryFeedback(input());
    for (const field of [
      "entry_id", "outcome", "note", "deviation", "engine_version", "agent_model",
      "toolkit_version", "client", "session_id", "install_id", "bearer",
    ]) {
      expect(notice, field).toContain(field);
    }
    expect(notice).toContain("uuid");
    expect(notice).not.toContain("hash");
    expect(notice).toContain("NOTHING has been sent");
    expect(notice).toContain("SUMMER_NO_TELEMETRY=1");
    expect(notice).toContain("DO_NOT_TRACK=1");
    // The disclosure names exactly the body keys the second call sends.
    await sendLibraryFeedback({ ...input(), client: "claude-code 2.1.0" });
    const body = sentBody();
    for (const key of Object.keys(body)) expect(notice, key).toContain(key);
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
  beforeEach(async () => {
    // The first call on a machine never sends; consume it so these tests
    // observe the POST.
    await consumeFirstRunNotice();
  });

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

  it("body carries reports, engine_version, agent_model, per-process session_id and toolkit_version", async () => {
    await sendLibraryFeedback(input());
    const body = sentBody();
    expect(body.reports).toEqual(input().reports);
    expect(body.engine_version).toBe("4.6.1");
    expect(body.agent_model).toBe("claude-fable-5");
    expect(body.session_id).toBe(getFeedbackSessionId());
    expect(body.toolkit_version).toBe(TOOLKIT_VERSION);
  });

  it("client (host app from handshake) is sent when provided, omitted when absent", async () => {
    await sendLibraryFeedback({ ...input(), client: "claude-code 2.1.0" });
    expect(sentBody().client).toBe("claude-code 2.1.0");
    await sendLibraryFeedback(input());
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string) as Record<
      string,
      unknown
    >;
    expect("client" in secondBody).toBe(false);
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

  it("network failure returns recorded:false, dropped:true, reason network and never throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await sendLibraryFeedback(input());
    expect(result).toEqual({ recorded: false, dropped: true, reason: "network" });
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
    expect(result).toEqual({ recorded: false, dropped: true, reason: "network" });
  });

  it("passes a 1s abort signal to fetch", async () => {
    await sendLibraryFeedback(input());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("non-2xx response is honest: recorded:false, dropped:true with status + reason (no queue, no retry)", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
    const result = await sendLibraryFeedback(input());
    expect(result).toEqual({ recorded: false, dropped: true, status: 429, reason: "rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 404 says the endpoint is missing — distinguishable from a blip (E2E F-03)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "not_found", message: "No API endpoint exists at POST /api/mcp/library-feedback." }), {
        status: 404,
      })
    );
    const result = await sendLibraryFeedback(input());
    expect(result).toEqual({ recorded: false, dropped: true, status: 404, reason: "endpoint_missing" });
  });

  it("classifies statuses: 404 endpoint_missing, other 4xx rejected, 5xx server_error", () => {
    expect(dropReasonForStatus(404)).toBe("endpoint_missing");
    expect(dropReasonForStatus(401)).toBe("rejected");
    expect(dropReasonForStatus(422)).toBe("rejected");
    expect(dropReasonForStatus(500)).toBe("server_error");
    expect(dropReasonForStatus(503)).toBe("server_error");
  });

  it("the drop reason changes nothing about what is SENT", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await sendLibraryFeedback(input());
    expect(Object.keys(sentBody()).sort()).toEqual(
      ["agent_model", "engine_version", "install_id", "reports", "session_id", "toolkit_version"]
    );
    expect(FEEDBACK_FIELDS_SENT).not.toMatch(/reason|status|dropped/);
  });

  it("2xx response returns exactly { recorded: true }", async () => {
    const result = await sendLibraryFeedback(input());
    expect(result).toEqual({ recorded: true });
  });
});
