import { describe, expect, it, vi } from "vitest";

vi.mock("../server.js", () => ({ bindMcpProject: vi.fn(), currentMcpEngineSelection: vi.fn(), logEngineSelfStart: vi.fn() }));

import { progressReporter } from "./local-project-tools.js";

describe("open_local progress", () => {
  it("sends notifications/progress with the message when the client gave a progress token", async () => {
    const sendNotification = vi.fn(async () => undefined);
    const progress = progressReporter({ _meta: { progressToken: "call-7" }, sendNotification });
    progress?.("Opening Castle…");
    expect(sendNotification).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: "call-7", progress: 1, message: "Opening Castle…" },
    });
  });

  it("sends nothing when the client did not ask for progress", () => {
    expect(progressReporter({ sendNotification: vi.fn(async () => undefined) })).toBeUndefined();
    expect(progressReporter(undefined)).toBeUndefined();
  });
});
