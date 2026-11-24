import { z } from "zod";
import { missingEngineOpResult, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { ToolInputError } from "../tool-errors.js";
import { asRecord } from "../util/json.js";
import { extractOpError } from "./engine-receipt.js";

export const createSceneInputShape = {
  path: z.string().describe("New scene path, e.g. 'res://scenes/empty_level.tscn'"),
  rootName: z.string().default("Main").describe("Root node name for the new scene"),
  rootType: z.string().default("Node3D").describe(
    "Concrete native Node type. Default 'Node3D'; common alternatives: 'Node2D', 'Control', 'Node'. Other types require an editor with GetClassInfo. For a project class_name, use its native base and attach the script."
  ),
  allow_temporary_scene_mutation: z.boolean().optional().describe(
    "DEPRECATED, ignored. Scene creation no longer mutates any open scene; kept only so older callers don't break."
  ),
};
export const createSceneInputSchema = z.object(createSceneInputShape).strict();
export type CreateSceneArgs = z.input<typeof createSceneInputSchema>;

interface CreateSceneClient extends CapabilityAdvertisingClient {
  executeIdentityBoundOps(
    ops: Record<string, unknown>[], options?: Record<string, unknown>, timeoutMs?: number
  ): Promise<unknown>;
  readProjectFile(path: string, maxBytes?: number): Promise<unknown>;
}

// Older full editors support these core roots. New editors query every class,
// including these, so restricted builds are checked against their own ClassDB.
const CORE_ROOTS = new Set(["Node", "Node2D", "Node3D", "Control"]);
const ROOT_CHECK_FALLBACK =
  "use a concrete native Node root such as Node3D, Node2D, Control or Node, then attach the project's script";

function refusal(rootType: string, reason: string): Record<string, unknown> {
  return {
    ok: false,
    failure_reason: "invalid_root_type",
    error: `Cannot create scene with rootType "${rootType}": ${reason} Nothing was written.`,
  };
}

function verificationUnavailable(rootType: string, reason: string): Record<string, unknown> {
  return {
    ok: false,
    failure_reason: "class_verification_unavailable",
    error: `Cannot verify rootType "${rootType}": ${reason} Nothing was written. Update the editor, or ${ROOT_CHECK_FALLBACK}.`,
  };
}

async function validateRootClass(client: CreateSceneClient, rootType: string): Promise<Record<string, unknown> | null> {
  const advertisesClassInfo = client.getEngineCapabilities?.()?.opKinds?.includes("GetClassInfo");
  if (CORE_ROOTS.has(rootType) && !advertisesClassInfo) return null;
  const missing = missingEngineOpResult(client, "GetClassInfo", ROOT_CHECK_FALLBACK);
  if (missing) return verificationUnavailable(rootType, "this editor does not advertise GetClassInfo.");
  const response = await client.executeIdentityBoundOps([{ op: "GetClassInfo", class_name: rootType }]);
  if (extractOpError(response)) return asRecord(response) ?? verificationUnavailable(rootType, "the editor's class query failed.");
  const envelope = asRecord(response);
  const info = Array.isArray(envelope?.results) ? asRecord(envelope.results[0]) : envelope;
  if (info?.ok !== true || info.class_name !== rootType || typeof info.exists !== "boolean" ||
      typeof info.native_class !== "boolean" || typeof info.is_node !== "boolean" || typeof info.can_instantiate !== "boolean") {
    return verificationUnavailable(rootType, "the editor returned no usable class metadata.");
  }
  if (info.kind === "script") {
    return refusal(rootType,
      `this is a project script class. Use its native base as rootType and attach ${String(info.script_path)} with summer_set_prop script; class_name is not a .tscn native type.`);
  }
  if (!info.exists) return refusal(rootType, "the engine has no native class with that name.");
  if (!info.native_class) return verificationUnavailable(rootType, "the editor did not identify a native class.");
  if (!info.is_node) return refusal(rootType, "the class does not inherit Node.");
  if (!info.can_instantiate) return refusal(rootType, "the class is abstract or cannot be instantiated.");
  return null;
}

/** Shared MCP/CLI implementation. Validation precedes the atomic create-only
 *  write; failures never clean up a path another actor might now own. */
export async function createScene(client: CreateSceneClient, args: CreateSceneArgs): Promise<Record<string, unknown>> {
  const { path, rootName, rootType } = createSceneInputSchema.parse(args);
  const safePath = path.trim().replace(/\\/g, "/");
  if (!safePath.startsWith("res://") || safePath.includes("..")) {
    throw new ToolInputError("Scene path must be a traversal-free res:// project path.");
  }
  if (!safePath.endsWith(".tscn")) throw new ToolInputError("New scenes must use the text format: the path must end in .tscn.");
  if (!/^[A-Za-z_][A-Za-z0-9_\- ]*$/.test(rootName)) throw new ToolInputError(`Invalid rootName "${rootName}".`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rootType)) throw new ToolInputError(`Invalid rootType "${rootType}".`);
  const invalid = await validateRootClass(client, rootType);
  if (invalid) return invalid;
  const rootHeader = `[node name="${rootName}" type="${rootType}"]`;
  const content = `[gd_scene format=3]\n\n${rootHeader}\n`;
  const receipt = await client.executeIdentityBoundOps([{
    op: "WriteFile", path: safePath, content, mustNotExist: true,
  }]);
  if (extractOpError(receipt)) return asRecord(receipt) ?? { ok: false, error: "Scene creation failed." };
  let verified = false;
  let verifyError: string | undefined;
  try {
    const read = asRecord(await client.readProjectFile(safePath, 4096));
    const readBack = asRecord(read?.data)?.content;
    if (read?.ok === false) verifyError = String(read.error ?? "engine could not read the file back");
    else if (typeof readBack !== "string") verifyError = "engine returned no text content on read-back";
    else if (readBack.trim() !== content.trim()) verifyError = "read-back content does not match the created scene root name and type";
    else verified = true;
  } catch (error) {
    verifyError = error instanceof Error ? error.message : String(error);
  }
  return {
    ok: true, created: safePath, rootName, rootType, verified, ...(verifyError ? { verifyError } : {}), receipt,
    hint: "The new scene is on disk but not open. Call summer_open_scene to start editing it.",
  };
}
