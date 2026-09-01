import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({
  getClient: vi.fn(),
  resetClient: vi.fn(),
}));

vi.mock("../../core/telemetry.js", () => ({
  recordMcpSession: vi.fn(),
}));

import { getClient } from "../server.js";
import { prioritizeDiagnostics, registerDebugTools } from "./debug-tools.js";

type RegisteredTool = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function tools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  registerDebugTools({
    tool(
      name: string,
      _description: string,
      _schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      registered.push({ name, handler });
      return { name };
    },
  } as never);
  return registered;
}

function tool(registered: RegisteredTool[], name: string): RegisteredTool {
  const found = registered.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function text(result: unknown): string {
  const envelope = result as { content?: Array<{ text?: string }> };
  return envelope.content?.[0]?.text ?? "";
}

function consoleMessage(type: string, textBody: string): Record<string, unknown> {
  return { text: textBody, count: 1, type };
}

/** Engine-shaped diagnostics payload: newest-first messages, noisy baseline. */
function enginePayload(): Record<string, unknown> {
  return {
    ok: true,
    data: {
      console: {
        errors: 1,
        warnings: 1,
        std: 40,
        editor: 2,
        total: 43,
        returned: 43,
        messages: [
          consoleMessage("std", "noise-0 (newest)"),
          consoleMessage("error", "task-specific failure"),
          ...Array.from({ length: 20 }, (_, i) => consoleMessage("std", `noise-${i + 1}`)),
          consoleMessage("warning", "one warning"),
          ...Array.from({ length: 20 }, (_, i) => consoleMessage("editor", `editor-noise-${i}`)),
        ],
      },
      debugger: {
        errors: 2,
        warnings: 60,
        session_active: true,
        is_breaked: false,
        errors_data: [
          { severity: "error", error: "boom-newest" },
          { severity: "error", error: "boom-older" },
        ],
        warnings_data: Array.from({ length: 50 }, (_, i) => ({
          severity: "warning",
          error: `warn-${i}`,
        })),
      },
      script_errors: { errors: [], count: 0 },
      total_errors: 3,
      total_warnings: 61,
      has_issues: true,
      guidance: "Errors present.",
    },
    provenance: { source: "diagnostics" },
    appliedThroughSeq: 7,
    snapshotSeq: 9,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prioritizeDiagnostics", () => {
  it("reorders console messages errors-first and caps the info tail at 10", () => {
    const shaped = prioritizeDiagnostics(enginePayload()) as {
      data: {
        console: { messages: Array<{ type: string; text: string }>; returned: number; total: number };
      };
      _view: Record<string, unknown>;
    };
    const messages = shaped.data.console.messages;
    expect(messages[0]).toMatchObject({ type: "error", text: "task-specific failure" });
    expect(messages[1]).toMatchObject({ type: "warning", text: "one warning" });
    const tail = messages.slice(2);
    expect(tail).toHaveLength(10);
    expect(tail.every((m) => m.type === "std" || m.type === "editor")).toBe(true);
    // Newest-first order preserved within the noise bucket — the kept tail is
    // the most recent noise, not the oldest.
    expect(tail[0].text).toBe("noise-0 (newest)");
    expect(shaped.data.console.returned).toBe(12);
    // Counts remain the engine truth.
    expect(shaped.data.console.total).toBe(43);
  });

  it("keeps debugger errors untouched and caps warnings_data at 20 newest", () => {
    const shaped = prioritizeDiagnostics(enginePayload()) as {
      data: {
        debugger: {
          errors: number;
          warnings: number;
          errors_data: unknown[];
          warnings_data: Array<{ error: string }>;
        };
      };
    };
    expect(shaped.data.debugger.errors_data).toHaveLength(2);
    expect(shaped.data.debugger.warnings_data).toHaveLength(20);
    expect(shaped.data.debugger.warnings_data[0].error).toBe("warn-0");
    // True counts are not rewritten by the trim.
    expect(shaped.data.debugger.errors).toBe(2);
    expect(shaped.data.debugger.warnings).toBe(60);
  });

  it("reports honest counters and an includeAll hint in _view", () => {
    const shaped = prioritizeDiagnostics(enginePayload()) as {
      _view: {
        mode: string;
        totalConsole: number;
        shownConsole: number;
        suppressedInfo: number;
        totalDebugger: number;
        shownDebugger: number;
        suppressedDebuggerWarnings: number;
        hint: string;
      };
    };
    expect(shaped._view.mode).toBe("prioritized");
    expect(shaped._view.totalConsole).toBe(43);
    expect(shaped._view.shownConsole).toBe(12);
    // 41 noise messages in the array, 10 kept.
    expect(shaped._view.suppressedInfo).toBe(31);
    expect(shaped._view.totalDebugger).toBe(62);
    expect(shaped._view.shownDebugger).toBe(22);
    expect(shaped._view.suppressedDebuggerWarnings).toBe(30);
    expect(shaped._view.hint).toContain("includeAll");
  });

  it("does not mutate the input payload", () => {
    const payload = enginePayload();
    const before = JSON.stringify(payload);
    prioritizeDiagnostics(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it("passes through payloads without a data dict unchanged", () => {
    expect(prioritizeDiagnostics(null)).toBeNull();
    expect(prioritizeDiagnostics("nope")).toBe("nope");
    const noData = { ok: false, error: "engine main thread unresponsive" };
    expect(prioritizeDiagnostics(noData)).toBe(noData);
  });

  it("tolerates missing console/debugger sections", () => {
    const shaped = prioritizeDiagnostics({ ok: true, data: { total_errors: 0 } }) as {
      data: Record<string, unknown>;
      _view: { totalConsole: number; totalDebugger: number };
    };
    expect(shaped.data.total_errors).toBe(0);
    expect(shaped._view.totalConsole).toBe(0);
    expect(shaped._view.totalDebugger).toBe(0);
  });

  it("keeps every error and warning even when they outnumber the noise cap", () => {
    const payload = enginePayload();
    const data = payload.data as Record<string, unknown>;
    const consoleData = data.console as Record<string, unknown>;
    consoleData.messages = Array.from({ length: 30 }, (_, i) =>
      consoleMessage(i % 2 === 0 ? "error" : "warning", `sev-${i}`)
    );
    const shaped = prioritizeDiagnostics(payload) as {
      data: { console: { messages: unknown[] } };
      _view: { suppressedInfo: number };
    };
    expect(shaped.data.console.messages).toHaveLength(30);
    expect(shaped._view.suppressedInfo).toBe(0);
  });
});

describe("summer_get_diagnostics tool", () => {
  it("returns the prioritized view by default", async () => {
    const getDiagnostics = vi.fn().mockResolvedValue(enginePayload());
    vi.mocked(getClient).mockResolvedValue({ getDiagnostics } as never);

    const result = await tool(tools(), "summer_get_diagnostics").handler({});
    const body = JSON.parse(text(result)) as {
      data: { console: { messages: Array<{ type: string }> } };
      _view: { mode: string };
    };
    expect(getDiagnostics).toHaveBeenCalledTimes(1);
    expect(body._view.mode).toBe("prioritized");
    expect(body.data.console.messages[0].type).toBe("error");
  });

  it("returns the untrimmed engine payload with includeAll: true", async () => {
    const payload = enginePayload();
    const getDiagnostics = vi.fn().mockResolvedValue(payload);
    vi.mocked(getClient).mockResolvedValue({ getDiagnostics } as never);

    const result = await tool(tools(), "summer_get_diagnostics").handler({
      includeAll: true,
    });
    const body = JSON.parse(text(result)) as {
      data: { console: { messages: unknown[] }; debugger: { warnings_data: unknown[] } };
      _view?: unknown;
    };
    expect(body._view).toBeUndefined();
    expect(body.data.console.messages).toHaveLength(43);
    expect(body.data.debugger.warnings_data).toHaveLength(50);
  });
});
