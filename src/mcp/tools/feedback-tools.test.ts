import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/feedback/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../core/feedback/client.js")>();
  return {
    ...actual,
    sendLibraryFeedback: vi.fn(),
  };
});

import { sendLibraryFeedback } from "../../core/feedback/client.js";
import {
  captureClientInfo,
  ENTRY_ID_PATTERN,
  FEEDBACK_TOOL_DESCRIPTION,
  feedbackInputSchema,
  OUTCOMES,
  registerFeedbackTools,
} from "./feedback-tools.js";

const mockedSend = vi.mocked(sendLibraryFeedback);

type RegisteredTool = {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function register(
  clientInfo?: { name?: unknown; version?: unknown } | (() => never)
): RegisteredTool {
  let registered: RegisteredTool | null = null;
  registerFeedbackTools({
    server: {
      getClientVersion:
        typeof clientInfo === "function" ? clientInfo : () => clientInfo,
    },
    tool(
      name: string,
      description: string,
      _schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      registered = { name, description, handler };
      return { name };
    },
  } as never);
  if (!registered) throw new Error("tool was not registered");
  return registered;
}

function report(overrides: Record<string, unknown> = {}) {
  return { entry_id: "skill/grappling-hook", outcome: "worked", ...overrides };
}

function valid(overrides: Record<string, unknown> = {}) {
  return {
    reports: [report()],
    engine_version: "4.6.1",
    agent_model: "claude-fable-5",
    ...overrides,
  };
}

describe("input schema", () => {
  it("accepts every outcome enum value", () => {
    for (const outcome of OUTCOMES) {
      const parsed = feedbackInputSchema.safeParse(
        valid({ reports: [report({ outcome })] })
      );
      expect(parsed.success, outcome).toBe(true);
    }
  });

  it("rejects unknown outcomes", () => {
    expect(
      feedbackInputSchema.safeParse(
        valid({ reports: [report({ outcome: "failed" })] })
      ).success
    ).toBe(false);
  });

  it("validates entry_id kind/slug with optional content hash", () => {
    const good = [
      "tool/generate-3d",
      "skill/grappling-hook",
      "example/stylized-forest-scene@1a2b3c4d",
      "template/fps-slice@" + "a".repeat(64),
      "collection/fantasy-forest",
      "reference/godot-input-map",
    ];
    for (const entry_id of good) {
      expect(ENTRY_ID_PATTERN.test(entry_id), entry_id).toBe(true);
    }
    const bad = [
      "skills/grappling-hook", // wrong kind word
      "skill/Grappling-Hook", // uppercase
      "skill/hook@xyz", // non-hex hash
      "skill/hook@" + "a".repeat(7), // hash too short
      "skill/hook@" + "a".repeat(65), // hash too long
      "skill/", // empty slug
      "grappling-hook", // missing kind
    ];
    for (const entry_id of bad) {
      expect(ENTRY_ID_PATTERN.test(entry_id), entry_id).toBe(false);
    }
  });

  it("caps note and deviation at 280 chars", () => {
    const at = "x".repeat(280);
    const over = "x".repeat(281);
    expect(
      feedbackInputSchema.safeParse(
        valid({ reports: [report({ note: at, deviation: at })] })
      ).success
    ).toBe(true);
    expect(
      feedbackInputSchema.safeParse(valid({ reports: [report({ note: over })] }))
        .success
    ).toBe(false);
    expect(
      feedbackInputSchema.safeParse(
        valid({ reports: [report({ deviation: over })] })
      ).success
    ).toBe(false);
  });

  it("enforces batch limits: 1-10 reports", () => {
    expect(feedbackInputSchema.safeParse(valid({ reports: [] })).success).toBe(
      false
    );
    expect(
      feedbackInputSchema.safeParse(
        valid({ reports: Array.from({ length: 10 }, () => report()) })
      ).success
    ).toBe(true);
    expect(
      feedbackInputSchema.safeParse(
        valid({ reports: Array.from({ length: 11 }, () => report()) })
      ).success
    ).toBe(false);
  });

  it("requires engine_version", () => {
    expect(
      feedbackInputSchema.safeParse({
        reports: [report()],
        agent_model: "claude-fable-5",
      }).success
    ).toBe(false);
    expect(
      feedbackInputSchema.safeParse(valid({ engine_version: "" })).success
    ).toBe(false);
  });

  it("requires agent_model, 1-64 chars", () => {
    expect(
      feedbackInputSchema.safeParse({
        reports: [report()],
        engine_version: "4.6.1",
      }).success
    ).toBe(false);
    expect(
      feedbackInputSchema.safeParse(valid({ agent_model: "" })).success
    ).toBe(false);
    expect(
      feedbackInputSchema.safeParse(valid({ agent_model: "x".repeat(64) }))
        .success
    ).toBe(true);
    expect(
      feedbackInputSchema.safeParse(valid({ agent_model: "x".repeat(65) }))
        .success
    ).toBe(false);
  });

  it('allows the literal "unknown" agent_model so no report is blocked', () => {
    expect(
      feedbackInputSchema.safeParse(valid({ agent_model: "unknown" })).success
    ).toBe(true);
  });
});

describe("tool registration", () => {
  it("registers summer_library_feedback with the disclosure copy", () => {
    const tool = register();
    expect(tool.name).toBe("summer_library_feedback");
    expect(tool.description).toBe(FEEDBACK_TOOL_DESCRIPTION);
    // Disclosure invariants from SELF_IMPROVING_LIBRARY.md §3.
    expect(tool.description).toContain(
      "no field for project files, chat content, or code"
    );
    // Every body key the client sends is named, and the anonymous id is
    // described as what it is (a random uuid, not a "hash").
    for (const field of [
      "entry_id", "outcome", "note", "deviation", "engine_version", "agent_model",
      "toolkit_version", "client", "session_id", "install_id", "bearer",
    ]) {
      expect(tool.description, field).toContain(field);
    }
    expect(tool.description).toContain("uuid");
    expect(tool.description).not.toContain("install hash");
    expect(tool.description).toContain("first_run");
    expect(tool.description).toContain("dropped:true");
    expect(tool.description).toContain("SUMMER_NO_TELEMETRY=1");
    expect(tool.description).toContain("DO_NOT_TRACK=1");
    expect(tool.description).toContain("future sessions");
  });

  it("handler forwards to the core client and wraps its result as text JSON", async () => {
    mockedSend.mockResolvedValue({ recorded: true });
    const tool = register({ name: "claude-code", version: "2.1.0" });
    const result = (await tool.handler(valid())) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(mockedSend).toHaveBeenCalledWith({
      reports: valid().reports,
      engine_version: "4.6.1",
      agent_model: "claude-fable-5",
      client: "claude-code 2.1.0",
    });
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ recorded: true });
  });

  it("client capture: undefined when the handshake carried no clientInfo, never throws", async () => {
    mockedSend.mockResolvedValue({ recorded: true });
    const tool = register(undefined);
    await tool.handler(valid());
    expect(mockedSend).toHaveBeenCalledWith(
      expect.objectContaining({ client: undefined })
    );
  });

  it("captureClientInfo tolerates missing/odd SDK shapes", () => {
    expect(
      captureClientInfo({
        server: { getClientVersion: () => ({ name: "cursor", version: "1.2" }) },
      } as never)
    ).toBe("cursor 1.2");
    expect(
      captureClientInfo({
        server: { getClientVersion: () => ({ name: "cursor" }) },
      } as never)
    ).toBe("cursor");
    expect(
      captureClientInfo({
        server: { getClientVersion: () => undefined },
      } as never)
    ).toBeUndefined();
    expect(
      captureClientInfo({
        server: { getClientVersion: () => ({ name: 42, version: "1.2" }) },
      } as never)
    ).toBeUndefined();
    expect(captureClientInfo({} as never)).toBeUndefined();
    expect(
      captureClientInfo({
        server: {
          getClientVersion: () => {
            throw new Error("boom");
          },
        },
      } as never)
    ).toBeUndefined();
  });

  it("handler surfaces the disabled result verbatim", async () => {
    mockedSend.mockResolvedValue({ recorded: false, disabled: true });
    const tool = register();
    const result = (await tool.handler(valid())) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(result.content[0].text)).toEqual({
      recorded: false,
      disabled: true,
    });
  });
});
