/**
 * Engine capability pre-flight — the honesty rule (design §2.1, acceptance
 * criterion 5): a task whose replay or evidence collection needs an op the
 * engine's /api/health `capabilities.opKinds` does not advertise is REFUSED
 * with `evidence_missing:engine_lacks_op` before anything is sent, instead of
 * being scored as zeros. Same posture as the toolkit's own per-tool pre-flight
 * (src/core/capability-skew.ts): an engine that advertises no op list proves
 * nothing and is allowed through.
 */

import { createHash } from "node:crypto";
import { parseEngineCapabilities } from "../../../dist/core/capability-skew.js";
import { PREDICATE_EVIDENCE } from "./assert.ts";
import { taskNeedsProbe } from "./probe.ts";
import type { TaskSpec } from "./tasks.ts";
import { recordOpNeeds, type GoldenTrajectory } from "./trajectory.ts";

/** Ops the harness itself sends on every task. */
export const HARNESS_OPS: readonly string[] = ["OpenScene", "GetWorldSnapshot", "DiffWorldSnapshot", "SaveScene", "SaveDirtyScenes", "SaveDirtyScripts"];

/** Ops each evidence phase sends. `preview` includes RunSceneScript because
 *  the blank-frame check decodes the returned JPEG inside the editor. */
export const EVIDENCE_OPS: Record<string, readonly string[]> = {
  runtime: ["PlayGame", "IsGameRunning", "GetDebuggerErrors", "StopGame"],
  probe: ["RunVerification"],
  preview: ["ScenePreview", "RunSceneScript"],
};

export function evidencePhases(task: Pick<TaskSpec, "assertions" | "probe_snippet">): Set<string> {
  const phases = new Set<string>();
  for (const a of task.assertions) for (const p of PREDICATE_EVIDENCE[a.predicate] ?? []) phases.add(p);
  if (taskNeedsProbe(task.assertions, task.probe_snippet)) phases.add("probe");
  return phases;
}

/** Every engine op this task's replay + evidence collection will send, with
 *  who needs it (for the refusal message). */
export function taskOpNeeds(task: Pick<TaskSpec, "assertions" | "probe_snippet">, golden: Pick<GoldenTrajectory, "records">): Map<string, string[]> {
  const needs = new Map<string, string[]>();
  const add = (op: string, why: string) => (needs.get(op) ?? needs.set(op, []).get(op)!).push(why);
  for (const op of HARNESS_OPS) add(op, "harness");
  for (const phase of evidencePhases(task)) for (const op of EVIDENCE_OPS[phase] ?? []) add(op, `evidence:${phase}`);
  for (const record of golden.records) for (const op of recordOpNeeds(record)) add(op, `replay:${record.tool}`);
  return needs;
}

export interface Preflight {
  /** False when the engine predates the advert — absence proves nothing. */
  advertised: boolean;
  opkinds_sha256: string | null;
  needed: string[];
  /** Needed ops the advert provably lacks; non-empty = refuse the task. */
  missing: string[];
  simulated_missing: string[];
}

/** `simulate` removes ops from the advert (test hook: proves the refusal path
 *  against a real build without needing an older engine). */
export function preflight(health: Record<string, unknown>, needs: Map<string, string[]>, simulate: string[] = []): Preflight {
  const caps = parseEngineCapabilities(health.capabilities);
  let advertised = caps?.opKinds ? [...caps.opKinds] : null;
  if (advertised && simulate.length > 0) advertised = advertised.filter((op) => !simulate.includes(op));
  const needed = [...needs.keys()].sort();
  const missing = advertised ? needed.filter((op) => !advertised!.includes(op)) : [];
  return {
    advertised: advertised !== null,
    opkinds_sha256: caps?.opKinds ? createHash("sha256").update([...caps.opKinds].sort().join("\n")).digest("hex") : null,
    needed,
    missing,
    simulated_missing: simulate,
  };
}
