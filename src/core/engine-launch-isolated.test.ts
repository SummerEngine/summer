import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine.js")>();
  return { ...actual, listEngineInstances: vi.fn(), checkEngineHealth: vi.fn(), getApiPort: vi.fn() };
});

import { checkEngineHealth, getApiPort, listEngineInstances } from "./engine.js";
import { findOpenEditor } from "./engine-launch.js";

const instance = { instanceId: "owned", resourceRoot: "/task/game", port: 6550, pid: 123 };

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe("isolated editor discovery", () => {
  it("does not accept another process that reused the registered port", async () => {
    vi.stubEnv("SUMMER_ENGINE_STATE_DIR", "/task/state");
    vi.mocked(listEngineInstances).mockResolvedValue([instance as never]);
    vi.mocked(checkEngineHealth).mockResolvedValue({ ok: true, engine: "summer", version: "1", instanceId: "other" } as never);
    expect(await findOpenEditor("/task/game")).toEqual({ kind: "starting", port: 6550, pid: 123 });
    expect(getApiPort).not.toHaveBeenCalled();
  });

  it("accepts the owner and ignores an unowned legacy pointer when no instance exists", async () => {
    vi.stubEnv("SUMMER_ENGINE_STATE_DIR", "/task/state");
    vi.mocked(listEngineInstances).mockResolvedValueOnce([instance as never]).mockResolvedValueOnce([]);
    vi.mocked(checkEngineHealth).mockResolvedValue({ ok: true, engine: "summer", version: "1", instanceId: "owned" } as never);
    expect((await findOpenEditor("/task/game")).kind).toBe("this");
    expect(await findOpenEditor("/task/game")).toEqual({ kind: "none" });
    expect(getApiPort).not.toHaveBeenCalled();
  });
});
