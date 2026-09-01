import type { CloudManifest, ManifestFile } from "./types.js";

export type DecisionKind =
  | "push"
  | "pull"
  | "delete-local"
  | "delete-remote"
  | "conflict-remote-wins"
  | "keep-local"
  | "converged";

export interface PathDecision {
  path: string;
  kind: DecisionKind;
  base?: ManifestFile;
  local?: ManifestFile;
  remote?: ManifestFile;
}

export interface DiffPlan {
  decisions: PathDecision[];
  pushPaths: string[];
  pullPaths: string[];
  deleteLocalPaths: string[];
  deleteRemotePaths: string[];
  conflictPaths: string[];
  /** Row 14: local edit beat a remote delete; surfaced as a notice. */
  keepLocalPaths: string[];
  /** Row 15: remote edit beat a local delete; surfaced as a notice. */
  restoredRemotePaths: string[];
}

export function diffManifests(base: CloudManifest, local: CloudManifest, remote: CloudManifest): DiffPlan {
  const paths = new Set([...Object.keys(base.files), ...Object.keys(local.files), ...Object.keys(remote.files)]);
  const decisions: PathDecision[] = [];
  for (const path of [...paths].sort()) {
    const b = base.files[path];
    const l = local.files[path];
    const r = remote.files[path];
    const kind = decide(b, l, r);
    decisions.push({ path, kind, base: b, local: l, remote: r });
  }

  pairSidecars(decisions);
  return planFromDecisions(decisions);
}

function planFromDecisions(decisions: PathDecision[]): DiffPlan {
  return {
    decisions,
    pushPaths: decisions.filter((d) => d.kind === "push").map((d) => d.path),
    pullPaths: decisions.filter((d) => d.kind === "pull").map((d) => d.path),
    deleteLocalPaths: decisions.filter((d) => d.kind === "delete-local").map((d) => d.path),
    deleteRemotePaths: decisions.filter((d) => d.kind === "delete-remote").map((d) => d.path),
    conflictPaths: decisions.filter((d) => d.kind === "conflict-remote-wins").map((d) => d.path),
    keepLocalPaths: decisions.filter((d) => d.kind === "keep-local").map((d) => d.path),
    restoredRemotePaths: decisions
      .filter((d) => d.kind === "pull" && d.base && !d.local && d.remote && !same(d.remote, d.base))
      .map((d) => d.path),
  };
}

function decide(base?: ManifestFile, local?: ManifestFile, remote?: ManifestFile): DecisionKind {
  if (same(local, remote)) return "converged";
  if (!base && local && !remote) return "push";
  if (!base && !local && remote) return "pull";
  if (!base && local && remote) return same(local, remote) ? "converged" : "conflict-remote-wins";
  if (base && same(local, base) && remote && !same(remote, base)) return "pull";
  if (base && local && !same(local, base) && same(remote, base)) return "push";
  if (base && local && remote && same(local, remote)) return "converged";
  if (base && local && remote && !same(local, base) && !same(remote, base)) return "conflict-remote-wins";
  if (base && !local && same(remote, base)) return "delete-remote";
  if (base && same(local, base) && !remote) return "delete-local";
  if (base && !local && remote && !same(remote, base)) return "pull";
  if (base && local && !same(local, base) && !remote) return "keep-local";
  return "converged";
}

function same(a?: ManifestFile, b?: ManifestFile): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.sha256 === b.sha256 && a.size === b.size;
}

/**
 * Sidecar pairing (spec 8.4): foo.png + foo.png.import and foo.gd + foo.gd.uid
 * diff, transfer, delete, and conflict-resolve as one atomic unit. When the
 * primary and its sidecar disagree about which side wins, the primary's
 * direction wins and the sidecar decision is recomputed under that direction.
 */
export function sidecarPrimary(path: string): string | null {
  if (path.endsWith(".import")) return path.slice(0, -".import".length);
  if (path.endsWith(".uid")) return path.slice(0, -".uid".length);
  return null;
}

const REMOTE_WINS: ReadonlySet<DecisionKind> = new Set(["pull", "delete-local", "conflict-remote-wins"]);
const LOCAL_WINS: ReadonlySet<DecisionKind> = new Set(["push", "delete-remote", "keep-local"]);

function pairSidecars(decisions: PathDecision[]): void {
  const byPath = new Map(decisions.map((d) => [d.path, d]));
  for (const sidecar of decisions) {
    const primaryPath = sidecarPrimary(sidecar.path);
    if (!primaryPath) continue;
    const primary = byPath.get(primaryPath);
    if (!primary) continue;

    // A converged sidecar (L == R) is compatible with either side and a
    // converged primary lets the sidecar act alone; only direction
    // disagreement inside the pair is overridden, with the primary winning.
    if (sidecar.kind === "converged" || primary.kind === "converged") continue;
    if (REMOTE_WINS.has(primary.kind) && !REMOTE_WINS.has(sidecar.kind)) {
      sidecar.kind = forceRemoteSide(sidecar);
    } else if (LOCAL_WINS.has(primary.kind) && !LOCAL_WINS.has(sidecar.kind)) {
      sidecar.kind = forceLocalSide(sidecar);
    }
  }
}

function forceRemoteSide(sidecar: PathDecision): DecisionKind {
  if (sidecar.remote && sidecar.local && !same(sidecar.local, sidecar.remote)) return "conflict-remote-wins";
  if (sidecar.remote && !sidecar.local) return "pull";
  if (!sidecar.remote && sidecar.local) return "delete-local";
  return "converged";
}

function forceLocalSide(sidecar: PathDecision): DecisionKind {
  if (sidecar.local && !same(sidecar.local, sidecar.remote)) return "push";
  if (!sidecar.local && sidecar.remote) return "delete-remote";
  return "converged";
}

/**
 * Mass-deletion guardrail (spec 8.5). Confirmation required when deletions
 * exceed 10 files, reach 20% of the base, or cover the entire base.
 */
export function assertDeleteGuard(plan: DiffPlan, baseFileCount: number, confirmDeletes?: boolean): void {
  const deletes = plan.deleteRemotePaths.length;
  if (!deletes) return;
  const tooMany =
    deletes > 10 ||
    (baseFileCount > 0 && deletes >= Math.ceil(baseFileCount * 0.2)) ||
    deletes === baseFileCount;
  if (tooMany && !confirmDeletes) {
    throw new Error(`Push would delete ${deletes} cloud files. Re-run with --confirm-deletes after verifying the project path.`);
  }
}

/**
 * Hard abort (spec 8.5): base non-empty and the local tree reads as completely
 * empty (unmounted volume, wrong directory). No confirmation can override this.
 */
export function assertNotEmptyLocalTree(baseFileCount: number, localFileCount: number): void {
  if (baseFileCount > 0 && localFileCount === 0) {
    throw new Error(
      "Local project tree is empty but the sync base is not. This looks like an unmounted volume or wrong directory. Aborting sync; no confirmation can push this."
    );
  }
}
