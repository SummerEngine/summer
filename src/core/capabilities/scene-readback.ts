/**
 * scene-readback — read a scene back from disk after SaveScene and parse it,
 * ONE copy for every tool that proves a change from the saved file instead of
 * trusting the engine receipt (summer_replace_node, summer_batch with
 * ReparentNode, summer_connect_signal).
 *
 * The engine's `scenePersistence.persisted` only says SaveScene returned OK
 * (ops_executor.cpp: scene_persistence["persisted"] =
 * explicit_scene_save_succeeded); what the file holds is only known by reading
 * it. The client renames that flag to `saved` (engine-receipt.ts
 * honestSceneReceipt); `verified` is set only by tools that read back here.
 */
import { asRecord, type JsonRecord } from "../util/json.js";
import { parseTscn, type ParsedTscn } from "./tscn.js";

/** The engine's /api/state/read-file window used for scene read-backs. */
export const SCENE_READ_LIMIT = 1_000_000;

export type ReadbackFailure = JsonRecord & { ok: false; error: string; failure_reason: string };

export function readbackFailure(failure_reason: string, error: string, extra: JsonRecord = {}): ReadbackFailure {
  return { ok: false, failure_reason, error, ...extra };
}

export function isReadbackFailure(value: unknown): value is ReadbackFailure {
  return (
    !!value &&
    typeof value === "object" &&
    (value as JsonRecord).ok === false &&
    typeof (value as JsonRecord).failure_reason === "string"
  );
}

export interface SavedSceneReader {
  readProjectFile(path: string, maxBytes?: number): Promise<unknown>;
}

export interface SavedScene {
  parsed: ParsedTscn;
  sha256?: string;
}

/**
 * Read `scenePath` as saved and parse it. `tooLargeHint` is appended to the
 * scene_too_large failure (what to do instead when the file cannot be
 * verified through the 1 MB read window).
 */
export async function readSavedScene(
  client: SavedSceneReader,
  scenePath: string,
  tooLargeHint = ""
): Promise<SavedScene | ReadbackFailure> {
  let read: JsonRecord | null;
  try {
    read = asRecord(await client.readProjectFile(scenePath, SCENE_READ_LIMIT));
  } catch (err) {
    return readbackFailure("scene_unreadable", `Could not read ${scenePath} back: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!read || read.ok === false) {
    return readbackFailure("scene_unreadable", `Could not read ${scenePath} back: ${String(read?.error ?? "no response")}`);
  }
  const data = asRecord(read.data);
  if (typeof data?.content !== "string") {
    return readbackFailure("scene_unreadable", `${scenePath} did not read back as text (binary .scn scenes cannot be verified).`);
  }
  if (data.truncated === true) {
    return readbackFailure(
      "scene_too_large",
      `${scenePath} is larger than the 1 MB read window, so the change could not be planned and verified from the saved file.` +
        (tooLargeHint ? ` ${tooLargeHint}` : "")
    );
  }
  return {
    parsed: parseTscn(data.content),
    ...(typeof data.sha256 === "string" ? { sha256: data.sha256 } : {}),
  };
}
