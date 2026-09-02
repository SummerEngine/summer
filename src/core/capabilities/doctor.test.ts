import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAuthToken, saveUserInfo } from "../auth.js";
import { setSummerDirForTests } from "../store.js";
import { checkEngineInstall, checkLogin } from "./doctor.js";
import type { DoctorCheck } from "./doctor.js";

vi.mock("../engine-install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engine-install.js")>();
  return { ...actual, findEngineBinary: vi.fn(() => null) };
});

import { ENGINE_BINARY_ENV, findEngineBinary } from "../engine-install.js";

const findEngineBinaryMock = vi.mocked(findEngineBinary);

function summarize(checks: DoctorCheck[]) {
  return {
    ok: checks.filter((c) => c.status === "ok").length,
    warnings: checks.filter((c) => c.status === "warning").length,
    failures: checks.filter((c) => c.status === "fail").length,
  };
}

describe("doctor summarization", () => {
  it("counts mixed statuses", () => {
    const summary = summarize([
      { id: "a", label: "A", status: "ok", message: "" },
      { id: "b", label: "B", status: "warning", message: "" },
      { id: "c", label: "C", status: "fail", message: "" },
      { id: "d", label: "D", status: "ok", message: "" },
    ]);
    expect(summary).toEqual({ ok: 2, warnings: 1, failures: 1 });
  });

  it("counts an all-ok run", () => {
    const summary = summarize([
      { id: "a", label: "A", status: "ok", message: "" },
      { id: "b", label: "B", status: "ok", message: "" },
    ]);
    expect(summary).toEqual({ ok: 2, warnings: 0, failures: 0 });
  });

  it("counts an empty check list", () => {
    expect(summarize([])).toEqual({ ok: 0, warnings: 0, failures: 0 });
  });
});

describe("doctor login check", () => {
  let root = "";
  const originalToken = process.env.SUMMER_TOKEN;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "summer-doctor-test-"));
    setSummerDirForTests(join(root, ".summer"));
    delete process.env.SUMMER_TOKEN;
  });

  afterEach(async () => {
    setSummerDirForTests(null);
    if (originalToken === undefined) delete process.env.SUMMER_TOKEN;
    else process.env.SUMMER_TOKEN = originalToken;
    await rm(root, { recursive: true, force: true });
  });

  it("warns when nothing is signed in and says engine tools do not need it", async () => {
    const check = await checkLogin();
    expect(check.status).toBe("warning");
    expect(check.message).toContain("summer login");
    expect(check.message).toContain("engine tools work without");
  });

  it("reports the stored identity when signed in via the file", async () => {
    await saveAuthToken("file-token");
    await saveUserInfo({ id: "user-1", email: "maker@example.com" });
    expect(await checkLogin()).toMatchObject({
      status: "ok",
      message: "maker@example.com",
    });
  });

  it("reports the env source when SUMMER_TOKEN is set, even with a stored login present", async () => {
    await saveAuthToken("file-token");
    await saveUserInfo({ id: "user-1", email: "maker@example.com" });
    process.env.SUMMER_TOKEN = "env-token";
    expect(await checkLogin()).toMatchObject({
      status: "ok",
      message: "token from SUMMER_TOKEN env",
    });
  });

  it("ignores a whitespace-only SUMMER_TOKEN and falls back to the file identity", async () => {
    await saveAuthToken("file-token");
    await saveUserInfo({ id: "user-1", email: "maker@example.com" });
    process.env.SUMMER_TOKEN = "   ";
    expect(await checkLogin()).toMatchObject({
      status: "ok",
      message: "maker@example.com",
    });
  });
});

describe("doctor engine check", () => {
  beforeEach(() => {
    findEngineBinaryMock.mockReset();
    findEngineBinaryMock.mockReturnValue(null);
  });

  it("resolves the binary through the shared engine-install module", () => {
    findEngineBinaryMock.mockReturnValue("/Applications/Summer.app/Contents/MacOS/Summer");
    const check = checkEngineInstall();
    expect(findEngineBinaryMock).toHaveBeenCalledTimes(1);
    expect(check).toMatchObject({
      status: "ok",
      message: "/Applications/Summer.app",
      details: { path: "/Applications/Summer.app/Contents/MacOS/Summer" },
    });
  });

  it("points at SUMMER_ENGINE_BINARY when no binary is found", () => {
    const check = checkEngineInstall();
    expect(check.status).toBe("warning");
    expect(check.message).toContain("summer install");
    expect(check.message).toContain(ENGINE_BINARY_ENV);
    expect(ENGINE_BINARY_ENV).toBe("SUMMER_ENGINE_BINARY");
  });
});
