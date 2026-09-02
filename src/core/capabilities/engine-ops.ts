/**
 * Engine op helpers shared by both faces — the MCP tools (src/mcp/tools/*) and
 * the CLI dispatch table (src/core/capabilities/tool-dispatch.ts). ONE copy of
 * the scene-mutation single-op contract and of the guarded-file safety checks.
 */
import type { EngineApiClient } from "../api-client.js";
import { resolveSingleOnlyOps } from "../capability-skew.js";
import { ToolInputError } from "../tool-errors.js";
import { asRecord, type JsonRecord } from "../util/json.js";
import { extractOpError } from "./engine-receipt.js";

// ---------------------------------------------------------------------------
// Scene-mutation dispatch. The engine rejects multi-op batches containing
// single-only ops wholesale, and every scene mutation batch ends in exactly one
// SaveScene. Single-only classification comes from the engine's /api/health
// advert when present, else core/capability-skew FALLBACK_SINGLE_ONLY_OPS.
// ---------------------------------------------------------------------------

export function isSingleOnlyOp(kind: string, singleOnly: ReadonlySet<string>): boolean {
  return singleOnly.has(kind) || kind.startsWith("Git");
}

/** Append the transaction-boundary SaveScene (or validate the caller's). */
export function sceneMutationOps(ops: JsonRecord[]): JsonRecord[] {
  const saveIndexes = ops
    .map((op, index) => (op.op === "SaveScene" ? index : -1))
    .filter((index) => index >= 0);
  if (saveIndexes.length > 1) {
    throw new ToolInputError("A scene mutation batch may contain only one SaveScene");
  }
  if (saveIndexes.length === 1) {
    if (saveIndexes[0] !== ops.length - 1) {
      throw new ToolInputError("SaveScene must be the final operation in a scene mutation batch");
    }
    return ops;
  }
  return [...ops, { op: "SaveScene" }];
}

/** Split an op list into sequential engine requests: consecutive batchable ops
 *  stay grouped, each single-only op becomes its own request. Order preserved. */
export function chunkOpsForDispatch(
  ops: JsonRecord[],
  singleOnly: ReadonlySet<string>
): JsonRecord[][] {
  const chunks: JsonRecord[][] = [];
  let current: JsonRecord[] = [];
  for (const op of ops) {
    if (isSingleOnlyOp(String(op.op ?? ""), singleOnly)) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
      }
      chunks.push([op]);
    } else {
      current.push(op);
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Execute an op list as sequential engine requests honoring the single-op
 *  dispatch contract. Receipts from every request are preserved and merged, so
 *  an op that applied followed by one that failed is reported honestly instead
 *  of masked. */
export async function executeOpsChunked(
  send: (chunk: JsonRecord[]) => Promise<unknown>,
  ops: JsonRecord[],
  singleOnly: ReadonlySet<string>
): Promise<unknown> {
  const chunks = chunkOpsForDispatch(ops, singleOnly);
  if (chunks.length === 1) return send(chunks[0]!);

  const receipts: unknown[] = [];
  const combinedResults: JsonRecord[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const receipt = await send(chunks[i]!);
    receipts.push(receipt);
    const envelope = (receipt ?? {}) as JsonRecord;
    if (Array.isArray(envelope.results)) {
      combinedResults.push(...(envelope.results as JsonRecord[]));
    }
    if (extractOpError(receipt)) {
      const failedKind = String(chunks[i]![0]?.op ?? "batch");
      const appliedOps = chunks.slice(0, i).flat().map((op) => String(op.op ?? ""));
      const notSent = chunks.slice(i + 1).flat().map((op) => String(op.op ?? ""));
      const baseError =
        (typeof envelope.error === "string" && envelope.error) || `Engine request failed (${failedKind}).`;
      const honestError =
        appliedOps.length > 0
          ? `${baseError} NOTE: ${appliedOps.length} earlier op(s) already applied (${appliedOps.join(", ")})` +
            (failedKind === "SaveScene"
              ? " — the scene is modified in the editor but NOT saved to disk. Fix the problem, then call summer_save_scene."
              : ".") +
            (notSent.length > 0 ? ` Not sent: ${notSent.join(", ")}.` : "")
          : baseError;
      return {
        ...envelope,
        error: honestError,
        results: combinedResults,
        receipts,
      };
    }
  }
  const last = (receipts[receipts.length - 1] ?? {}) as JsonRecord;
  return { ...last, results: combinedResults, requests: chunks.length, receipts };
}

/** Scene mutation entry point: appends the transaction-boundary SaveScene, then
 *  dispatches with the single-op contract (mutations batch together, SaveScene
 *  and other single-only ops travel alone). */
export function executeSceneMutation(
  client: EngineApiClient,
  scenePath: string,
  ops: JsonRecord[],
  options?: JsonRecord
): Promise<unknown> {
  return executeOpsChunked(
    (chunk) => client.executeIdentityBoundOps(chunk, { ...(options ?? {}), scenePath }),
    sceneMutationOps(ops),
    resolveSingleOnlyOps(client)
  );
}

// ---------------------------------------------------------------------------
// Guarded file helpers: fail-closed writes, sha256 receipts.
// ---------------------------------------------------------------------------

/** Normalize a project path; refuses anything that is not a traversal-free res:// path. */
export function safeProjectPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/");
  if (!normalized.startsWith("res://") || normalized.includes("..")) {
    throw new ToolInputError("File path must be a traversal-free res:// project path.");
  }
  return normalized;
}

export function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

/** Validate a ReadFile receipt for a safe text mutation: text content, not
 *  truncated, with a full-file sha256 the follow-up WriteFile can guard on. */
export function readTextPayload(result: unknown): {
  content: string;
  sha256: string;
  size?: number;
} {
  const root = asRecord(result);
  const data = asRecord(root?.data);
  if (root?.ok === false) {
    throw new Error(String(root.error ?? "Engine could not read the file."));
  }
  if (data?.encoding === "binary" || typeof data?.content !== "string") {
    throw new Error("Safe text mutation refused: the engine did not return text content.");
  }
  if (data.truncated === true) {
    throw new Error("Safe text mutation refused: the file exceeds the 1 MB read limit.");
  }
  const sha256 = typeof data.sha256 === "string" ? data.sha256 : undefined;
  if (!validSha256(sha256)) {
    throw new Error("Safe text mutation refused: the engine did not return a full-file sha256 receipt.");
  }
  return {
    content: data.content,
    sha256,
    size: typeof data.size === "number" ? data.size : undefined,
  };
}

export function occurrenceCount(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index < 0) return count;
    count++;
    offset = index + needle.length;
  }
}
