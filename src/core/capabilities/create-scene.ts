import { z } from "zod";
import { resolveSceneRoot, type SceneClassClient } from "./scene-root-class.js";
import { escapeTscnString } from "./seeing/probe.js";
import { ToolInputError } from "../tool-errors.js";
import { asRecord } from "../util/json.js";
import { extractOpError } from "./engine-receipt.js";

export const createSceneInputShape = {
  path: z.string().describe("New scene path, e.g. 'res://scenes/empty_level.tscn'"),
  rootName: z.string().default("Main").describe("Root node name for the new scene"),
  rootType: z.string().default("Node3D").describe(
    "Concrete native Node, or a registered GDScript class open in the editor with a constructor that accepts no arguments. Default 'Node3D'."
  ),
  allow_temporary_scene_mutation: z.boolean().optional().describe(
    "DEPRECATED, ignored. Scene creation no longer mutates any open scene; kept only so older callers don't break."
  ),
};
export const createSceneInputSchema = z.object(createSceneInputShape).strict();
export type CreateSceneArgs = z.input<typeof createSceneInputSchema>;

interface CreateSceneClient extends SceneClassClient {
  readProjectFile(path: string, maxBytes?: number): Promise<unknown>;
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
  const root = await resolveSceneRoot(client, rootType);
  if ("failure" in root) return root.failure;
  const rootHeader = `[node name="${rootName}" type="${root.nativeType}"]`;
  const content = root.scriptPath
    ? `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="${escapeTscnString(root.scriptPath)}" id="1_script"]\n\n${rootHeader}\nscript = ExtResource("1_script")\n`
    : `[gd_scene format=3]\n\n${rootHeader}\n`;
  const receipt = await client.executeIdentityBoundOps([{
    op: "WriteFile", path: safePath, content, mustNotExist: true,
  }]);
  if (extractOpError(receipt)) return asRecord(receipt) ?? { ok: false, error: "Scene creation failed." };
  let verified = false;
  let verifyError: string | undefined;
  try {
    const read = asRecord(await client.readProjectFile(safePath, Math.max(4096, Buffer.byteLength(content))));
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
