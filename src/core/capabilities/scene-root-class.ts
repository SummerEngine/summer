import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityAdvertisingClient } from "../capability-skew.js";
import { PACKAGE_ROOT } from "../package-root.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { extractOpError, getFailureReason } from "./engine-receipt.js";
import { buildWrapperScene, enginePath, makeProbeDir } from "./seeing/probe.js";

export interface SceneClassClient extends CapabilityAdvertisingClient {
  executeIdentityBoundOps(ops: JsonRecord[], options?: JsonRecord, timeoutMs?: number): Promise<unknown>;
}

type Lookup = { info: JsonRecord } | { failure: JsonRecord };
type Root = { nativeType: string; scriptPath?: string } | { failure: JsonRecord };
const CORE_ROOTS = new Set(["Node", "Node2D", "Node3D", "Control"]);
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unavailable(className: string, why: string): { failure: JsonRecord } {
  return { failure: {
    ok: false,
    failure_reason: "class_verification_unavailable",
    error: `Cannot verify rootType "${className}": ${why}. No scene was written.`,
  } };
}

function invalid(className: string, why: string): { failure: JsonRecord } {
  return { failure: {
    ok: false,
    failure_reason: "invalid_root_type",
    error: `Cannot create a scene with rootType "${className}": ${why}. No scene was written.`,
  } };
}

function singleResult(envelope: JsonRecord | null): JsonRecord | null {
  if (!Array.isArray(envelope?.results)) return envelope;
  return envelope.results.length === 1 ? asRecord(envelope.results[0]) : null;
}

async function probeClassInfo(client: SceneClassClient, className: string): Promise<Lookup> {
  const dir = await makeProbeDir();
  try {
    const requestId = randomUUID();
    const kernel = await readFile(join(PACKAGE_ROOT, "assets/scene/class_info_probe.gd"), "utf8");
    const wrapper = join(dir, "wrapper.tscn");
    await writeFile(join(dir, "config.json"), JSON.stringify({ request_id: requestId, class_name: className }));
    await writeFile(wrapper, buildWrapperScene(undefined, kernel));
    const reply = asRecord(await client.executeIdentityBoundOps([
      { op: "ScenePreview", scene_path: enginePath(wrapper), size: [16, 16] },
    ]));
    const row = singleResult(reply);
    // The metadata callback precedes this specific final image readback on the 0.8.8 dummy renderer.
    // All other refusals and missing receipts are terminal, even if a result file exists.
    const readbackError = "Failed to read preview viewport image";
    const noHeadlessPixels = reply && row?.op === "ScenePreview" && row.ok === false && row.error === readbackError &&
      !getFailureReason(row) && !getFailureReason(reply) &&
      (reply.error === undefined || reply.error === readbackError) &&
      (reply.terminalState === undefined || reply.terminalState === "failed") &&
      (reply.errorClass === undefined || reply.errorClass === "fatal");
    if (!noHeadlessPixels) {
      if (reply && extractOpError(reply)) return { failure: reply };
      if (row?.op !== "ScenePreview" || row.ok !== true) return unavailable(className, "the class probe did not complete");
    }
    let result: JsonRecord | null = null;
    try {
      result = asRecord(JSON.parse(await readFile(join(dir, "result.json"), "utf8")));
    } catch {
      return unavailable(className, "the editor did not return class metadata");
    }
    const info = asRecord(result?.info);
    if (result?.request_id !== requestId || info?.class_name !== className) {
      return unavailable(className, "the returned metadata did not identify this class request");
    }
    return { info };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function lookup(client: SceneClassClient, className: string): Promise<Lookup> {
  const kinds = client.getEngineCapabilities?.()?.opKinds;
  if (kinds?.includes("GetClassInfo")) {
    const reply = asRecord(await client.executeIdentityBoundOps([{ op: "GetClassInfo", class_name: className }]));
    if (reply && extractOpError(reply)) return { failure: reply };
    const row = singleResult(reply);
    return row?.ok === true && row.op === "GetClassInfo" && row.class_name === className
      ? { info: row } : unavailable(className, "the editor returned incomplete class metadata");
  }
  if (kinds && !kinds.includes("ScenePreview")) return unavailable(className, "the editor lacks a class metadata read");
  return probeClassInfo(client, className);
}

export async function resolveSceneRoot(client: SceneClassClient, className: string): Promise<Root> {
  if (CORE_ROOTS.has(className) && !client.getEngineCapabilities?.()?.opKinds?.includes("GetClassInfo")) {
    return { nativeType: className };
  }
  const result = await lookup(client, className);
  if ("failure" in result) return result;
  const info = result.info;
  if (typeof info.exists !== "boolean" || typeof info.native_class !== "boolean" ||
      typeof info.is_node !== "boolean" || typeof info.can_instantiate !== "boolean") {
    return unavailable(className, "the editor returned incomplete class metadata");
  }
  if (!info.exists) return invalid(className, "the editor has no class with that name");
  if (!info.is_node) return invalid(className, "the class does not inherit Node");
  if (info.kind === "native" && info.native_class) {
    return info.can_instantiate ? { nativeType: className } : invalid(className, "the native class cannot be instantiated");
  }
  if (info.kind !== "script" || info.native_class || typeof info.abstract !== "boolean") {
    return unavailable(className, "the editor did not identify a concrete native or script class");
  }
  if (info.abstract) return invalid(className, "the registered script class is abstract");
  if (typeof info.native_base !== "string" || !CLASS_NAME.test(info.native_base) ||
      typeof info.script_path !== "string" || !info.script_path.startsWith("res://") || info.script_path.length <= 6 ||
      /[\\\u0000-\u001f]/.test(info.script_path) || info.script_path.split("/").includes("..")) {
    return unavailable(className, "the registered script lacks a usable project path or native base");
  }
  let concreteBase = info.base_can_instantiate;
  let requiredArguments = info.required_arguments;
  if (requiredArguments === undefined) {
    if (!client.getEngineCapabilities?.()?.opKinds?.includes("ScenePreview")) {
      return unavailable(className, "the editor does not provide script constructor metadata");
    }
    const probe = await probeClassInfo(client, className);
    if ("failure" in probe) return probe;
    if (probe.info.kind !== "script" || probe.info.script_path !== info.script_path || probe.info.native_base !== info.native_base) {
      return unavailable(className, "the script registration changed during verification");
    }
    requiredArguments = probe.info.required_arguments;
    concreteBase = probe.info.base_can_instantiate;
  }
  if (typeof requiredArguments !== "number" || !Number.isSafeInteger(requiredArguments) || requiredArguments < 0) {
    return unavailable(className, "the editor has no current GDScript constructor metadata. For a registered GDScript class, open its script in the selected editor, save any edits and retry");
  }
  if (requiredArguments > 0) return invalid(className, "the script constructor requires arguments that a scene cannot supply");
  // GetClassInfo always reports can_instantiate=false for a script. Its native base must be concrete.
  if (typeof concreteBase !== "boolean") {
    const base = await lookup(client, info.native_base);
    if ("failure" in base) return base;
    if (base.info.kind !== "native" || base.info.exists !== true || base.info.native_class !== true ||
        base.info.is_node !== true || typeof base.info.can_instantiate !== "boolean") {
      return unavailable(className, "the editor did not verify the script's native Node base");
    }
    concreteBase = base.info.can_instantiate;
  }
  return concreteBase ? { nativeType: info.native_base, scriptPath: info.script_path } : invalid(className, "the native base cannot be instantiated");
}
