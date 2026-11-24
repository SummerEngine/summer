import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSceneRoot } from "./scene-root-class.js";
import type { JsonRecord } from "../util/json.js";

const nativeInfo = {
  class_name: "Camera3D", kind: "native", native_class: true,
  exists: true, is_node: true, can_instantiate: true,
};
const headless = { ok: false, op: "ScenePreview", error: "Failed to read preview viewport image" };

function legacy(run: (dir: string, id: string) => Promise<JsonRecord>, className = "Camera3D") {
  const dirs: string[] = [];
  return {
    dirs,
    getEngineCapabilities: () => ({ opKinds: ["ScenePreview", "WriteFile"] }),
    async executeIdentityBoundOps(ops: JsonRecord[]) {
      expect(ops).toHaveLength(1);
      expect(ops[0].op).toBe("ScenePreview");
      const dir = dirname(String(ops[0].scene_path));
      dirs.push(dir);
      const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
      expect(config.class_name).toBe(className);
      expect(await readFile(join(dir, "wrapper.tscn"), "utf8")).not.toContain(className);
      return { results: [await run(dir, config.request_id)] };
    },
  };
}

describe("private class lookup on legacy editors", () => {
  it.each([true, false])("accepts a matching result when pixel readback succeeds=%s", async (pixels) => {
    const client = legacy(async (dir, id) => {
      await writeFile(join(dir, "result.json"), JSON.stringify({ request_id: id, info: nativeInfo }));
      return pixels ? { ok: true, op: "ScenePreview" } : headless;
    });
    await Promise.all([0, 1].map(async () => {
      expect(await resolveSceneRoot(client, "Camera3D")).toEqual({ nativeType: "Camera3D" });
    }));
    expect(new Set(client.dirs).size).toBe(2);
    for (const dir of client.dirs) await expect(access(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing", "wrong id", "wrong class", "malformed"])("refuses a %s result and cleans up", async (bad) => {
    const client = legacy(async (dir, id) => {
      if (bad !== "missing") {
        await writeFile(join(dir, "result.json"), bad === "malformed" ? "{" : JSON.stringify({
          request_id: bad === "wrong id" ? "stale" : id,
          info: { ...nativeInfo, class_name: bad === "wrong class" ? "Control" : "Camera3D" },
        }));
      }
      return headless;
    });
    expect(await resolveSceneRoot(client, "Camera3D")).toMatchObject({ failure: { failure_reason: "class_verification_unavailable" } });
    await expect(access(client.dirs[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a different native refusal even with a matching output file", async () => {
    const blocked = { ok: false, op: "ScenePreview", error: "stop play", failure_reason: "game_running" };
    const client = legacy(async (dir, id) => {
      await writeFile(join(dir, "result.json"), JSON.stringify({ request_id: id, info: nativeInfo }));
      return blocked;
    });
    expect(await resolveSceneRoot(client, "Camera3D")).toEqual({ failure: { results: [blocked] } });
    await expect(access(client.dirs[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [0, null],
    [1, "invalid_root_type"],
    [-1, "class_verification_unavailable"],
    [null, "class_verification_unavailable"],
  ])("requires a known zero-argument script constructor (%s)", async (requiredArguments, reason) => {
    const name = "RegisteredFixture";
    const client = legacy(async (dir, id) => {
      await writeFile(join(dir, "result.json"), JSON.stringify({ request_id: id, info: {
        class_name: name, exists: true, kind: "script", native_class: false, is_node: true,
        can_instantiate: false, abstract: false, native_base: "Camera3D", script_path: "res://fixture.gd",
        base_can_instantiate: true, required_arguments: requiredArguments,
      } }));
      return headless;
    }, name);
    const resolved = await resolveSceneRoot(client, name);
    if (reason) expect(resolved).toMatchObject({ failure: { failure_reason: reason } });
    else expect(resolved).toEqual({ nativeType: "Camera3D", scriptPath: "res://fixture.gd" });
  });

  it("retains an envelope failure when the nested row mentions image readback", async () => {
    const probe = legacy(async (dir, id) => {
      await writeFile(join(dir, "result.json"), JSON.stringify({ request_id: id, info: nativeInfo }));
      return headless;
    });
    const client = { ...probe, executeIdentityBoundOps: async (ops: JsonRecord[]) => ({
      ...await probe.executeIdentityBoundOps(ops), terminalState: "identity_mismatch",
      error: "Selected project changed", failure_reason: "rejected_identity",
    }) };
    expect(await resolveSceneRoot(client, "Camera3D")).toMatchObject({
      failure: { terminalState: "identity_mismatch", failure_reason: "rejected_identity" },
    });
    await expect(access(probe.dirs[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up a transport failure and propagates it", async () => {
    const client = legacy(async () => { throw new Error("connection lost"); });
    await expect(resolveSceneRoot(client, "Camera3D")).rejects.toThrow("connection lost");
    await expect(access(client.dirs[0])).rejects.toMatchObject({ code: "ENOENT" });
  });
});
