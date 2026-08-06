import type { EngineApiClient } from "../../lib/api-client.js";
import { extractOpError } from "./with-engine.js";

type Receipt = Record<string, unknown> & {
  results?: unknown[];
  terminalState?: string;
  appliedSeq?: number;
};

function asReceipt(value: unknown): Receipt {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Receipt
    : {};
}

function combinedSuccess(mutationReceipt: Receipt | null, saveReceipt: Receipt): Receipt {
  const mutationResults = Array.isArray(mutationReceipt?.results) ? mutationReceipt.results : [];
  const saveResults = Array.isArray(saveReceipt.results) ? saveReceipt.results : [];
  return {
    ok: true,
    status: "ok",
    terminalState: saveReceipt.terminalState ?? mutationReceipt?.terminalState ?? "applied",
    appliedSeq: saveReceipt.appliedSeq ?? mutationReceipt?.appliedSeq,
    results: [...mutationResults, ...saveResults],
    mutationReceipt,
    saveReceipt,
  };
}

/**
 * Apply scene edits and persist them using the editor's transport contract.
 *
 * Current editors require SaveScene to be submitted as a single operation so
 * it cannot block the editor thread. Older MCP clients batched it after the
 * mutation, which makes the whole request fail before anything is applied.
 */
export async function executeSceneMutation(
  client: EngineApiClient,
  scenePath: string,
  ops: Record<string, unknown>[],
  options?: Record<string, unknown>,
): Promise<unknown> {
  const saveIndexes = ops
    .map((op, index) => op.op === "SaveScene" ? index : -1)
    .filter((index) => index >= 0);
  if (saveIndexes.length > 1) {
    throw new Error("A scene mutation batch may contain only one SaveScene");
  }
  if (saveIndexes.length === 1 && saveIndexes[0] !== ops.length - 1) {
    throw new Error("SaveScene must be the final operation in a scene mutation batch");
  }

  const saveOp = saveIndexes.length === 1
    ? ops[saveIndexes[0]!]!
    : { op: "SaveScene" };
  const mutationOps = saveIndexes.length === 1 ? ops.slice(0, -1) : ops;
  const scopedOptions = { ...(options ?? {}), scenePath };

  let mutationReceipt: Receipt | null = null;
  if (mutationOps.length > 0) {
    mutationReceipt = asReceipt(
      await client.executeIdentityBoundOps(mutationOps, scopedOptions),
    );
    if (extractOpError(mutationReceipt)) return mutationReceipt;
  }

  const saveReceipt = asReceipt(
    await client.executeIdentityBoundOps([saveOp], scopedOptions),
  );
  const saveError = extractOpError(saveReceipt);
  if (saveError) {
    if (!mutationReceipt) return saveReceipt;
    return {
      ...saveReceipt,
      ok: false,
      status: "error",
      error:
        `Scene mutation applied in the editor, but saving ${scenePath} failed: ${saveError} ` +
        "The scene may contain unsaved changes; inspect or undo before retrying.",
      mutationReceipt,
      saveReceipt,
    };
  }

  return combinedSuccess(mutationReceipt, saveReceipt);
}
