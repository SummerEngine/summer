import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine.js")>();
  return { ...actual, listEngineInstances: vi.fn(), checkEngineHealth: vi.fn(), getApiPort: vi.fn() };
});

import { checkEngineHealth, getApiPort, listEngineInstances } from "./engine.js";
import { findOpenEditor, launchEditor } from "./engine-launch.js";
import { setSummerDirForTests } from "./store.js";

const instance = { instanceId: "owned", resourceRoot: "/task/game", port: 6550, pid: 123 };

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe("isolated editor discovery", () => {
  it("does not accept another process that reused the registered port", async () => {
    vi.stubEnv("SUMMER_ENGINE_STATE_DIR", "/task/state");
    vi.mocked(listEngineInstances).mockResolvedValue([instance as never]);
    vi.mocked(checkEngineHealth).mockResolvedValue({ ok: true, engine: "summer", version: "1", instanceId: "other" } as never);
    expect(await findOpenEditor("/task/game")).toEqual({ kind: "starting", port: 6550, pid: 123, instanceId: "owned" });
    expect(getApiPort).not.toHaveBeenCalled();
  });

  it("does not report a reused port as running while waiting for an isolated editor", async () => {
    const state = mkdtempSync(join(tmpdir(), "isolated-launch-test-"));
    setSummerDirForTests(state);
    try {
      vi.stubEnv("SUMMER_ENGINE_STATE_DIR", join(state, "api"));
      vi.mocked(listEngineInstances).mockResolvedValue([instance as never]);
      vi.mocked(checkEngineHealth).mockResolvedValue({ ok: true, engine: "summer", version: "1", instanceId: "other" } as never);
      const result = await launchEditor({ projectPath: "/task/game", posture: "background", waitMs: 1, out: { log() {}, error() {} } });
      expect(result.status).toBe("starting");
    } finally {
      setSummerDirForTests(null);
      rmSync(state, { recursive: true, force: true });
    }
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
