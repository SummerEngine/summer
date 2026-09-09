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

describe("summer_get_console scope (E2E 2026-09-03 F-07)", () => {
  const engineConsole = {
    ok: true,
    op: "GetConsoleOutput",
    messages: [
      consoleMessage("std", "Welcome to Summer Engine"),
      consoleMessage("warning", "This control can't grab focus"),
    ],
    summary: { errors: 0, warnings: 1, std: 1, editor: 0, total: 2 },
  };

  it("stamps _scope on the shaped result so a clean console is never read as the post-play verdict", async () => {
    const executeOps = vi.fn().mockResolvedValue(engineConsole);
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);
    const result = await tool(tools(), "summer_get_console").handler({
      max_lines: 100,
      errors_only: true,
      strict_errors: false,
      raw: false,
    });
    const body = JSON.parse(text(result));
    expect(body._scope).toContain("Runtime errors from a played game are collected by the debugger");
    expect(body._scope).toContain("summer_get_diagnostics");
    // The default filter still drops std noise by TYPE, not by content, and says so.
    expect(body._filter.droppedByLevel).toBe(1);
    expect(body.messages).toHaveLength(1);
    expect(body.summary.errors).toBe(0);
  });

  it("returns raw engine output verbatim (no _scope, no filtering)", async () => {
    const executeOps = vi.fn().mockResolvedValue(engineConsole);
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);
    const result = await tool(tools(), "summer_get_console").handler({
      max_lines: 100,
      errors_only: true,
      strict_errors: false,
      raw: true,
    });
    const body = JSON.parse(text(result));
    expect(body._scope).toBeUndefined();
    expect(body.messages).toHaveLength(2);
  });
});

describe("summer_play — determinism params", () => {
  it("focus:true without pins calls play(scene) and returns the plain receipt (v1 launch)", async () => {
    const play = vi.fn().mockResolvedValue({ status: "ok", results: [{ ok: true, op: "PlayGame", playing: true, scene: "res://main.tscn" }] });
    const executeOps = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ play, executeOps } as never);

    const result = await tool(tools(), "summer_play").handler({ scene: "res://main.tscn", focus: true });
    expect(play).toHaveBeenCalledWith("res://main.tscn");
    expect(executeOps).not.toHaveBeenCalled();
    expect(text(result)).not.toContain("Determinism");
    expect(JSON.parse(text(result)).results[0].playing).toBe(true);
  });

  it("defaults to QUIET play: the PlayGame op with agent:true, and trusts the engine's agent_quiet echo", async () => {
    const play = vi.fn();
    const executeOps = vi.fn().mockResolvedValue({ status: "ok", results: [{ ok: true, op: "PlayGame", playing: true, agent_quiet: true }] });
    vi.mocked(getClient).mockResolvedValue({ play, executeOps } as never);

    const result = await tool(tools(), "summer_play").handler({ scene: "res://main.tscn" });
    expect(play).not.toHaveBeenCalled();
    expect(executeOps).toHaveBeenCalledWith([{ op: "PlayGame", scene: "res://main.tscn", agent: true }], undefined, 60_000);
    const body = JSON.parse(text(result));
    expect(body.results[0].agent_quiet).toBe(true);
    expect(body).not.toHaveProperty("posture_note");
  });

  it("flags an engine that predates quiet play (no agent_quiet echo on a launch)", async () => {
    const executeOps = vi.fn().mockResolvedValue({ status: "ok", results: [{ ok: true, op: "PlayGame", playing: true, scene: "main_scene" }] });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const body = JSON.parse(text(await tool(tools(), "summer_play").handler({})));
    expect(body.posture_note).toContain("predates quiet play");
  });

  it("passes seed/fixed_fps/time_scale through as the PlayGame op and narrates applied + seed_scope", async () => {
    const play = vi.fn();
    const executeOps = vi.fn().mockResolvedValue({
      status: "ok",
      results: [
        {
          ok: true,
          op: "PlayGame",
          playing: true,
          determinism: {
            seed: 42,
            fixed_fps: 60,
            args: ["--summer-seed", "42", "--fixed-fps", "60"],
            applied: true,
            seed_scope: "Pins the GLOBAL RNG only (randi/randf/...). NOT pinned: RandomNumberGenerator instances, scripts that call randomize(), wall-clock reads, thread timing.",
          },
        },
      ],
    });
    vi.mocked(getClient).mockResolvedValue({ play, executeOps } as never);

    const result = await tool(tools(), "summer_play").handler({ seed: 42, fixed_fps: 60 });
    // The /api/play rung copies only `scene`, so a pinned launch is the explicit op.
    expect(play).not.toHaveBeenCalled();
    expect(executeOps).toHaveBeenCalledWith([{ op: "PlayGame", agent: true, seed: 42, fixed_fps: 60 }], undefined, 60_000);
    const body = text(result);
    expect(body).toContain("Determinism (seed=42, fixed_fps=60): applied — flags on the child command line: --summer-seed 42 --fixed-fps 60.");
    expect(body).toContain("seed_scope: Pins the GLOBAL RNG only");
  });

  it("narrates applied:false with the engine's reason and hint", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      status: "ok",
      results: [
        {
          ok: true,
          op: "PlayGame",
          playing: true,
          note: "Game was already running",
          determinism: { seed: 7, args: ["--summer-seed", "7"], applied: false, reason: "already_running", hint: "StopGame first, then PlayGame again with seed/fixed_fps." },
        },
      ],
    });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const body = text(await tool(tools(), "summer_play").handler({ seed: 7 }));
    expect(body).toContain("Determinism (seed=7): NOT applied — reason: already_running.");
    expect(body).toContain("StopGame first");
  });

  it("says 'not applied (engine predates determinism params)' when pins were sent but no determinism block came back", async () => {
    const executeOps = vi.fn().mockResolvedValue({ status: "ok", results: [{ ok: true, op: "PlayGame", playing: true, scene: "res://main.tscn" }] });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const body = text(await tool(tools(), "summer_play").handler({ seed: 1, time_scale: 2 }));
    expect(executeOps).toHaveBeenCalledWith([{ op: "PlayGame", agent: true, seed: 1, time_scale: 2 }], undefined, 60_000);
    expect(body).toContain("Determinism (seed=1, time_scale=2): not applied (engine predates determinism params)");
    expect(body).toContain("NOT pinned");
  });

  it("surfaces the engine's bad_args refusal as a classified failure", async () => {
    const executeOps = vi.fn().mockResolvedValue({
      ok: false,
      results: [{ ok: false, op: "PlayGame", failure_reason: "bad_args", error: "PlayGame `fixed_fps` must be an integer > 0" }],
    });
    vi.mocked(getClient).mockResolvedValue({ executeOps } as never);

    const result = (await tool(tools(), "summer_play").handler({ fixed_fps: 30 })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("bad_args");
  });
});
