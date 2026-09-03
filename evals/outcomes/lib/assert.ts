/**
 * Assertion DSL — the exact-fact signal (design §1.3).
 *
 * Every predicate is a pure function over the evidence the runner collected:
 *   snap    GetWorldSnapshot after the agent phase
 *   diff    DiffWorldSnapshot baseline -> after
 *   tscn    the saved scene + project.godot AS THE AGENT LEFT THEM (read before
 *           the runner's own freeze save, so "did not save" is a failure)
 *   runtime PlayGame -> GetDebuggerErrors -> StopGame
 *   probe   RunVerification results.json (reports keyed by assertion id)
 *   preview ScenePreview framing:"camera"
 *
 * Two rules, both enforced here: (1) a predicate that cannot be evaluated —
 * missing evidence, op error, unknown predicate, unimplemented predicate — is
 * FAIL with reason `evidence_missing`, never a skip; (2) `required` predicates
 * gate the task, the rest are reported only.
 *
 * Selectors: `Wall*|Floor*` matches node NAMES (glob, alternation with `|`);
 * `path:Grid/*` matches the root-relative path; `class:StaticBody2D` matches
 * the class (snapshot) / `type` (tscn). `*` matches every node.
 */

import {
  nodeHasScript,
  parseTscnValue,
  projectInputEventCount,
  projectMainScene,
  type ProjectGodot,
  type TscnNode,
  type TscnResource,
  type TscnScene,
} from "./tscn.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "evidence_missing" | "unsaved" | "structural" | "spatial" | "runtime" | "visual_gate";

export const SEVERITY_ORDER: readonly Severity[] = [
  "evidence_missing",
  "unsaved",
  "structural",
  "spatial",
  "runtime",
  "visual_gate",
];

export interface AssertionSpec {
  id: string;
  predicate: string;
  args: Record<string, unknown>;
  required: boolean;
  note?: string;
}

export interface AssertionResult {
  id: string;
  predicate: string;
  required: boolean;
  pass: boolean;
  severity: Severity;
  /** Machine-readable failure class: evidence_missing | no_match | <predicate-specific>. */
  reason?: string;
  detail?: unknown;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Aabb {
  pos: Vec3;
  size: Vec3;
}

export interface SnapNode {
  path: string;
  class: string;
  name: string;
  pos?: string;
  rot_deg?: string | number;
  scale?: string;
  aabb?: { pos: string; size: string };
  visible?: boolean;
  script_fp?: string;
  material_fps?: string[];
  scene_file?: string;
}

export interface Snapshot {
  snapshot_id?: string;
  scene_path?: string;
  total_nodes?: number;
  truncated?: boolean;
  lights_truncated?: boolean;
  nodes: SnapNode[];
  lights: Array<{ path: string; class: string; energy: number; color: string }>;
  cameras: Array<{ path: string; current: boolean }>;
  environment_fp?: string;
  counts: Record<string, number>;
}

export interface Diff {
  from_id?: string;
  to_id?: string;
  added: string[];
  removed: string[];
  changed: Array<{ path: string; fields: string[] }>;
  counts_delta: Record<string, number>;
  environment_changed?: boolean;
  truncation_warning?: string;
}

export interface RuntimeEvidence {
  played: boolean;
  play_failure?: string;
  running_during_window: boolean | null;
  errors: unknown[];
  error_count: number | null;
  stopped: boolean;
  seconds: number;
}

export interface ProbeEvidence {
  ok: boolean;
  failure_reason?: string;
  error?: string;
  reports: Record<string, unknown>;
  frames: string[];
  frame_warnings: string[];
  errors_seen: string[];
  finished: boolean;
}

export interface PreviewEvidence {
  ok: boolean;
  failure_reason?: string;
  used_scene_camera?: boolean;
  used_synthetic_camera?: boolean;
  environment_used?: string;
  camera_path?: string;
  distinct_colors: number | null;
  bytes: number;
}

export interface GoldNode {
  name: string;
  aabb: { pos: string; size: string };
}

export interface Evidence {
  snap: Snapshot | null;
  snap_error?: string;
  diff: Diff | null;
  diff_error?: string;
  tscn: TscnScene | null;
  tscn_error?: string;
  project: ProjectGodot | null;
  project_error?: string;
  runtime: RuntimeEvidence | null;
  runtime_error?: string;
  probe: ProbeEvidence | null;
  probe_error?: string;
  preview: PreviewEvidence | null;
  preview_error?: string;
  gold?: GoldNode[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function parseVec3(raw: unknown): Vec3 | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^Vector3\(\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*\)$/);
  if (!m) return null;
  const v = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? v : null;
}

export function parseAabb(raw: SnapNode["aabb"] | GoldNode["aabb"] | undefined): Aabb | null {
  if (!raw) return null;
  const pos = parseVec3(raw.pos);
  const size = parseVec3(raw.size);
  return pos && size ? { pos, size } : null;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export interface Selectable {
  name: string;
  path: string;
  class?: string;
}

/** `Wall*|class:StaticBody2D|path:Grid/*` — any alternative matching selects
 *  the node. Name globs also match the LAST segment of a path-only input. */
export function matchSelector(selector: string, node: Selectable): boolean {
  for (const alt of selector.split("|").map((s) => s.trim()).filter(Boolean)) {
    if (alt.startsWith("class:")) {
      if (node.class !== undefined && globToRegExp(alt.slice(6)).test(node.class)) return true;
    } else if (alt.startsWith("path:")) {
      if (globToRegExp(alt.slice(5)).test(node.path)) return true;
    } else if (globToRegExp(alt).test(node.name)) {
      return true;
    }
  }
  return false;
}

/** Name-only alternatives of a selector, for the probe (which matches by
 *  Node.name.match(glob)); class:/path: alternatives are dropped. */
export function selectorNameGlobs(selector: string): string[] {
  return selector
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("class:") && !s.startsWith("path:"));
}

function lastSegment(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function selectSnap(snap: Snapshot, selector: string): SnapNode[] {
  return snap.nodes.filter((n) => matchSelector(selector, { name: n.name, path: n.path, class: n.class }));
}

function selectTscn(tscn: TscnScene, selector: string): TscnNode[] {
  return tscn.nodes.filter((n) => matchSelector(selector, { name: n.name, path: n.path, class: n.type }));
}

export type CompareOp = "==" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "matches" | "exists";

export function compare(actual: unknown, op: CompareOp, expected: unknown): boolean {
  switch (op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "==":
      return actual === expected || (typeof actual === "number" && typeof expected === "number" && Math.abs(actual - expected) < 1e-9);
    case "!=":
      return !compare(actual, "==", expected);
    case ">":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case ">=":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "<":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "<=":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "contains":
      if (Array.isArray(actual)) return actual.includes(expected);
      return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "matches":
      return typeof actual === "string" && typeof expected === "string" && new RegExp(expected).test(actual);
  }
}

function readOp(args: Record<string, unknown>): CompareOp {
  const op = args.op;
  const known: CompareOp[] = ["==", "!=", ">", ">=", "<", "<=", "contains", "matches", "exists"];
  if (typeof op === "string" && (known as string[]).includes(op)) return op as CompareOp;
  throw new Error(`unknown comparison op ${JSON.stringify(op)} (one of ${known.join(" ")})`);
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`predicate needs string arg "${key}"`);
  return v;
}

function num(args: Record<string, unknown>, key: string, fallback?: number): number {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (fallback !== undefined && v === undefined) return fallback;
  throw new Error(`predicate needs numeric arg "${key}"`);
}

function aabbIntersects(a: Aabb, b: Aabb, shrink: number): boolean {
  const axes: Array<keyof Vec3> = ["x", "y", "z"];
  for (const k of axes) {
    const aMin = a.pos[k] + shrink;
    const aMax = a.pos[k] + a.size[k] - shrink;
    const bMin = b.pos[k] + shrink;
    const bMax = b.pos[k] + b.size[k] - shrink;
    if (aMax <= bMin || bMax <= aMin) return false;
  }
  return true;
}

export function aabbIoU(a: Aabb, b: Aabb): number {
  const axes: Array<keyof Vec3> = ["x", "y", "z"];
  let inter = 1;
  for (const k of axes) {
    const lo = Math.max(a.pos[k], b.pos[k]);
    const hi = Math.min(a.pos[k] + a.size[k], b.pos[k] + b.size[k]);
    if (hi <= lo) return 0;
    inter *= hi - lo;
  }
  const vol = (v: Aabb) => v.size.x * v.size.y * v.size.z;
  const union = vol(a) + vol(b) - inter;
  return union > 0 ? inter / union : 0;
}

// ---------------------------------------------------------------------------
// Predicate table
// ---------------------------------------------------------------------------

type Outcome = { pass: boolean; reason?: string; detail?: unknown };

type PredicateFn = (args: Record<string, unknown>, ev: Evidence, spec: AssertionSpec) => Outcome;

const missing = (what: string, detail?: unknown): Outcome => ({
  pass: false,
  reason: "evidence_missing",
  detail: detail === undefined ? { missing: what } : { missing: what, ...(detail as object) },
});

function needSnap(ev: Evidence): Snapshot | Outcome {
  return ev.snap ?? missing("snap", ev.snap_error ? { error: ev.snap_error } : undefined);
}
function needDiff(ev: Evidence): Diff | Outcome {
  return ev.diff ?? missing("diff", ev.diff_error ? { error: ev.diff_error } : undefined);
}
function needTscn(ev: Evidence): TscnScene | Outcome {
  return ev.tscn ?? missing("tscn", ev.tscn_error ? { error: ev.tscn_error } : undefined);
}
function needProject(ev: Evidence): ProjectGodot | Outcome {
  return ev.project ?? missing("project.godot", ev.project_error ? { error: ev.project_error } : undefined);
}
function needProbe(ev: Evidence): ProbeEvidence | Outcome {
  if (!ev.probe) return missing("probe", ev.probe_error ? { error: ev.probe_error } : undefined);
  if (!ev.probe.ok) return missing("probe", { failure_reason: ev.probe.failure_reason, error: ev.probe.error });
  return ev.probe;
}
const isOutcome = (v: unknown): v is Outcome => !!v && typeof v === "object" && "pass" in (v as object);

export const PREDICATES: Record<string, PredicateFn> = {
  count(args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    const cls = str(args, "class");
    const op = readOp(args);
    const expected = num(args, "value");
    const actual = snap.counts[cls] ?? 0;
    return { pass: compare(actual, op, expected), reason: "count_mismatch", detail: { class: cls, actual, op, expected } };
  },

  exists(args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    const tscn = needTscn(ev);
    if (isOutcome(tscn)) return tscn;
    const selector = str(args, "selector");
    const inScene = selectSnap(snap, selector);
    if (inScene.length === 0) {
      return { pass: false, reason: "no_match", detail: { selector, in_scene: 0 } };
    }
    const saved = new Set(tscn.nodes.map((n) => n.path));
    const unsaved = inScene.filter((n) => !saved.has(n.path)).map((n) => n.path);
    return {
      pass: unsaved.length === 0,
      reason: "unsaved",
      detail: { selector, in_scene: inScene.length, unsaved: unsaved.slice(0, 20) },
    };
  },

  added_only(args, ev) {
    const diff = needDiff(ev);
    if (isOutcome(diff)) return diff;
    const globs = Array.isArray(args.added) ? (args.added as string[]) : [];
    const removedAllowed = Array.isArray(args.removed_allowed) ? (args.removed_allowed as string[]) : [];
    const matchesAny = (path: string, patterns: string[]) =>
      patterns.some((p) => matchSelector(p, { name: lastSegment(path), path }));
    const badAdded = diff.added.filter((p) => !matchesAny(p, globs));
    const badRemoved = diff.removed.filter((p) => !matchesAny(p, removedAllowed));
    return {
      pass: badAdded.length === 0 && badRemoved.length === 0,
      reason: badRemoved.length > 0 ? "fixture_removed" : "unexpected_added",
      detail: { added: diff.added.length, removed: diff.removed.length, unexpected_added: badAdded.slice(0, 20), unexpected_removed: badRemoved.slice(0, 20) },
    };
  },

  aabb_within(args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    const selector = str(args, "selector");
    const nodes = selectSnap(snap, selector).filter((n) => n.aabb);
    if (nodes.length === 0) return { pass: false, reason: "no_match", detail: { selector } };
    const min = Array.isArray(args.min) ? (args.min as number[]) : null;
    const max = Array.isArray(args.max) ? (args.max as number[]) : null;
    const size = (args.size ?? {}) as Record<string, [number, number]>;
    const failures: unknown[] = [];
    for (const n of nodes) {
      const box = parseAabb(n.aabb);
      if (!box) continue;
      const axes: Array<keyof Vec3> = ["x", "y", "z"];
      axes.forEach((k, i) => {
        if (min && box.pos[k] < min[i]! - 1e-6) failures.push({ path: n.path, axis: k, below_min: box.pos[k] });
        if (max && box.pos[k] + box.size[k] > max[i]! + 1e-6) failures.push({ path: n.path, axis: k, above_max: box.pos[k] + box.size[k] });
        const range = size[k];
        if (range && (box.size[k] < range[0] - 1e-6 || box.size[k] > range[1] + 1e-6)) {
          failures.push({ path: n.path, axis: k, size: box.size[k], range });
        }
      });
    }
    return { pass: failures.length === 0, reason: "outside_region", detail: { selector, matched: nodes.length, failures: failures.slice(0, 20) } };
  },

  no_overlap(args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    const a = selectSnap(snap, str(args, "a")).filter((n) => n.aabb);
    const b = selectSnap(snap, str(args, "b")).filter((n) => n.aabb);
    const tol = num(args, "tol", 0);
    if (a.length === 0 || b.length === 0) {
      return { pass: false, reason: "no_match", detail: { a: a.length, b: b.length } };
    }
    const overlaps: Array<[string, string]> = [];
    for (const na of a) {
      const boxA = parseAabb(na.aabb);
      if (!boxA) continue;
      for (const nb of b) {
        if (na.path === nb.path) continue;
        const boxB = parseAabb(nb.aabb);
        if (boxB && aabbIntersects(boxA, boxB, tol)) overlaps.push([na.path, nb.path]);
      }
    }
    return { pass: overlaps.length === 0, reason: "overlap", detail: { a: a.length, b: b.length, tol, overlaps: overlaps.slice(0, 20) } };
  },

  on_ground(args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    const selector = str(args, "selector");
    const groundY = num(args, "ground_y", 0);
    const eps = num(args, "eps", 0.05);
    const nodes = selectSnap(snap, selector).filter((n) => n.aabb);
    if (nodes.length === 0) return { pass: false, reason: "no_match", detail: { selector } };
    const floating = nodes
      .map((n) => ({ path: n.path, base_y: parseAabb(n.aabb)?.pos.y }))
      .filter((n) => n.base_y === undefined || Math.abs(n.base_y - groundY) > eps);
    return { pass: floating.length === 0, reason: "floating", detail: { selector, matched: nodes.length, ground_y: groundY, eps, floating: floating.slice(0, 20) } };
  },

  lights(args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    const min = num(args, "min", 1);
    const range = Array.isArray(args.energy_range) ? (args.energy_range as [number, number]) : null;
    const sum = snap.lights.reduce((s, l) => s + (typeof l.energy === "number" ? l.energy : 0), 0);
    const enough = snap.lights.length >= min;
    const inRange = !range || (sum >= range[0] && sum <= range[1]);
    return { pass: enough && inRange, reason: enough ? "energy_out_of_range" : "too_few_lights", detail: { lights: snap.lights.length, min, energy_sum: Math.round(sum * 1000) / 1000, energy_range: range } };
  },

  camera_current(_args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    const current = snap.cameras.filter((c) => c.current === true);
    return { pass: current.length === 1, reason: "camera_current_count", detail: { cameras: snap.cameras.length, current: current.map((c) => c.path) } };
  },

  camera_sees(args, ev, spec) {
    const probe = needProbe(ev);
    if (isOutcome(probe)) return probe;
    const report = probe.reports[spec.id] as Record<string, unknown> | undefined;
    if (!report) return missing("probe report", { key: spec.id });
    const fraction = num(args, "fraction", 1);
    const actual = typeof report.fraction === "number" ? report.fraction : null;
    const matched = typeof report.matched === "number" ? report.matched : 0;
    if (matched === 0) return { pass: false, reason: "no_match", detail: report };
    if (report.camera === false) return { pass: false, reason: "no_camera", detail: report };
    return { pass: actual !== null && actual >= fraction - 1e-9, reason: "out_of_frustum", detail: { ...report, required_fraction: fraction } };
  },

  collision_under(args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    const selector = str(args, "selector");
    const nodes = selectSnap(snap, selector);
    if (nodes.length === 0) return { pass: false, reason: "no_match", detail: { selector } };
    const byPath = new Map(snap.nodes.map((n) => [n.path, n]));
    const isBody = (cls: string | undefined) => !!cls && (/Body[23]D$/.test(cls) || /^Area[23]D$/.test(cls));
    const uncollided: string[] = [];
    for (const n of nodes) {
      const prefix = n.path === "." ? "" : `${n.path}/`;
      const hit = snap.nodes.some((d) => {
        if (!/^CollisionShape[23]D$|^CollisionPolygon[23]D$/.test(d.class)) return false;
        if (prefix && !d.path.startsWith(prefix)) return false;
        if (!prefix && d.path === ".") return false;
        const parentPath = d.path.includes("/") ? d.path.slice(0, d.path.lastIndexOf("/")) : ".";
        return isBody(byPath.get(parentPath)?.class);
      });
      if (!hit) uncollided.push(n.path);
    }
    return { pass: uncollided.length === 0, reason: "no_collision", detail: { selector, matched: nodes.length, without_collision: uncollided.slice(0, 20) } };
  },

  script_attached(args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    const tscn = needTscn(ev);
    if (isOutcome(tscn)) return tscn;
    const selector = str(args, "selector");
    const nodes = selectSnap(snap, selector);
    if (nodes.length === 0) return { pass: false, reason: "no_match", detail: { selector } };
    const saved = new Map(tscn.nodes.map((n) => [n.path, n]));
    const problems = nodes
      .map((n) => ({ path: n.path, live: !!n.script_fp, saved: nodeHasScript(saved.get(n.path) ?? { name: "", path: "", props: {} }) }))
      .filter((n) => !n.live || !n.saved);
    return { pass: problems.length === 0, reason: "no_script", detail: { selector, matched: nodes.length, problems: problems.slice(0, 20) } };
  },

  signal_connected(args, ev) {
    const tscn = needTscn(ev);
    if (isOutcome(tscn)) return tscn;
    const want = { from: str(args, "from"), signal: str(args, "signal"), to: str(args, "to"), method: str(args, "method") };
    const minCount = num(args, "min", 1);
    const g = (pattern: string, value: string) => matchSelector(pattern, { name: lastSegment(value), path: value });
    const hits = tscn.connections.filter(
      (c) => g(want.from, c.from) && g(want.signal, c.signal) && g(want.to, c.to) && g(want.method, c.method)
    );
    return { pass: hits.length >= minCount, reason: "not_connected", detail: { want, min: minCount, hits: hits.length, connections: tscn.connections.length } };
  },

  input_action(args, ev) {
    const project = needProject(ev);
    if (isOutcome(project)) return project;
    const name = str(args, "name");
    const minEvents = num(args, "min_events", 1);
    const count = projectInputEventCount(project, name);
    return { pass: count !== null && count >= minEvents, reason: count === null ? "action_missing" : "too_few_events", detail: { name, events: count, min_events: minEvents } };
  },

  main_scene(args, ev) {
    const project = needProject(ev);
    if (isOutcome(project)) return project;
    const want = str(args, "path");
    const actual = projectMainScene(project);
    return { pass: actual === want, reason: "main_scene_mismatch", detail: { want, actual } };
  },

  runs_clean(args, ev) {
    const rt = ev.runtime;
    if (!rt) return missing("runtime", ev.runtime_error ? { error: ev.runtime_error } : undefined);
    if (!rt.played) return missing("runtime", { play_failure: rt.play_failure });
    if (rt.error_count === null) return missing("runtime", { detail: "GetDebuggerErrors gave no count" });
    const seconds = num(args, "seconds", rt.seconds);
    const clean = rt.error_count === 0 && rt.running_during_window === true;
    return {
      pass: clean,
      reason: rt.running_during_window !== true ? "game_not_running" : "debugger_errors",
      detail: { seconds, running_during_window: rt.running_during_window, error_count: rt.error_count, errors: rt.errors.slice(0, 5), stopped: rt.stopped },
    };
  },

  runtime_prop() {
    // MVP-0 stub (design §5): no MVP-0 task reads a runtime property through
    // GetRuntimeNode; the predicate exists so a task that names it fails
    // loudly instead of being skipped.
    return missing("runtime_prop", { detail: "runtime_prop is not implemented in MVP-0 (GetRuntimeNode read); write the check as a probe_report" });
  },

  state_machine(args, ev, spec) {
    const probe = needProbe(ev);
    if (isOutcome(probe)) return probe;
    const report = probe.reports[spec.id] as Record<string, unknown> | undefined;
    if (!report) return missing("probe report", { key: spec.id });
    if (report.found === false) return { pass: false, reason: "no_match", detail: report };
    const expected = str(args, "expected_state");
    const pass = report.active === true && report.state === expected;
    return { pass, reason: report.active === true ? "wrong_state" : "tree_inactive", detail: { ...report, expected_state: expected } };
  },

  probe_report(args, ev) {
    const probe = needProbe(ev);
    if (isOutcome(probe)) return probe;
    const key = str(args, "key");
    if (!(key in probe.reports)) return missing("probe report", { key });
    const op = readOp(args);
    const actual = probe.reports[key];
    return { pass: compare(actual, op, args.value), reason: "report_mismatch", detail: { key, actual, op, expected: args.value } };
  },

  frame_not_blank(args, ev) {
    const probe = needProbe(ev);
    if (isOutcome(probe)) return probe;
    const name = str(args, "name");
    const file = name.endsWith(".jpg") ? name : `${name}.jpg`;
    if (!probe.frames.includes(file)) return missing("probe frame", { name, frames: probe.frames });
    const warned = probe.frame_warnings.filter((w) => w.includes(`"${name}"`));
    const colors = probe.reports[`_colors:${name}`];
    if (typeof colors !== "number") return missing("probe report", { key: `_colors:${name}` });
    return { pass: warned.length === 0 && colors > 1, reason: warned.length > 0 ? "frame_warning" : "blank_frame", detail: { name, distinct_colors: colors, frame_warnings: warned } };
  },

  preview_camera_ok(_args, ev) {
    const pv = ev.preview;
    if (!pv) return missing("preview", ev.preview_error ? { error: ev.preview_error } : undefined);
    if (!pv.ok) return { pass: false, reason: pv.failure_reason ?? "preview_failed", detail: pv };
    if (pv.distinct_colors === null) return missing("preview image analysis", pv);
    const pass = pv.used_scene_camera === true && pv.environment_used === "scene_world_environment" && pv.distinct_colors > 1;
    return { pass, reason: pv.used_scene_camera !== true ? "synthetic_camera" : pv.environment_used !== "scene_world_environment" ? "no_scene_environment" : "blank_frame", detail: pv };
  },

  no_truncation(_args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    const pass = snap.truncated === false && snap.lights_truncated !== true;
    return { pass, reason: "truncated", detail: { truncated: snap.truncated, lights_truncated: snap.lights_truncated ?? false, total_nodes: snap.total_nodes } };
  },

  gold_iou(args, ev) {
    const snap = needSnap(ev);
    if (isOutcome(snap)) return snap;
    if (!ev.gold || ev.gold.length === 0) return missing("gold", { detail: "task has no gold reference" });
    const minMean = num(args, "min", 0.9);
    const byName = new Map(snap.nodes.map((n) => [n.name, n]));
    const per: Array<{ name: string; iou: number }> = ev.gold.map((g) => {
      const live = byName.get(g.name);
      const a = parseAabb(g.aabb);
      const b = parseAabb(live?.aabb);
      return { name: g.name, iou: a && b ? Math.round(aabbIoU(a, b) * 1000) / 1000 : 0 };
    });
    const mean = per.reduce((s, p) => s + p.iou, 0) / per.length;
    return { pass: mean >= minMean - 1e-9, reason: "gold_mismatch", detail: { mean_iou: Math.round(mean * 1000) / 1000, min: minMean, per_name: per } };
  },

  /** `tscn:` inline checks from the design tables, generalized: a property on
   *  saved node(s). quantifier "all" (default) — every matched node satisfies;
   *  "any" — at least one does. A missing key reads as undefined (only `exists`
   *  / `!=` can pass against it). */
  tscn_prop(args, ev) {
    const tscn = needTscn(ev);
    if (isOutcome(tscn)) return tscn;
    const selector = str(args, "selector");
    const key = str(args, "key");
    const op = readOp(args);
    const quantifier = args.quantifier === "any" ? "any" : "all";
    const nodes = selectTscn(tscn, selector);
    if (nodes.length === 0) return { pass: false, reason: "no_match", detail: { selector } };
    const results = nodes.map((n) => {
      const raw = n.props[key];
      const actual = raw === undefined ? undefined : parseTscnValue(raw);
      return { path: n.path, actual, pass: compare(actual, op, args.value) };
    });
    const pass = quantifier === "any" ? results.some((r) => r.pass) : results.every((r) => r.pass);
    return { pass, reason: "prop_mismatch", detail: { selector, key, op, expected: args.value, quantifier, nodes: results.slice(0, 20) } };
  },

  /** A sub_resource of `type` exists in the saved scene; with `key`, at least
   *  one such resource has a property (glob over keys, e.g. `tracks/*` + `/type`)
   *  satisfying the comparison. */
  tscn_resource(args, ev) {
    const tscn = needTscn(ev);
    if (isOutcome(tscn)) return tscn;
    const type = str(args, "type");
    const resources: TscnResource[] = tscn.subResources.filter((r) => matchSelector(type, { name: r.type, path: r.type }));
    if (resources.length === 0) return { pass: false, reason: "resource_missing", detail: { type, sub_resources: tscn.subResources.length } };
    if (typeof args.key !== "string") return { pass: true, detail: { type, matched: resources.length } };
    const keyGlob = globToRegExp(args.key);
    const op = readOp(args);
    const hits: Array<{ id: string; key: string; actual: unknown }> = [];
    for (const r of resources) {
      for (const [k, raw] of Object.entries(r.props)) {
        if (!keyGlob.test(k)) continue;
        const actual = parseTscnValue(raw);
        if (compare(actual, op, args.value)) hits.push({ id: r.id, key: k, actual });
      }
    }
    return { pass: hits.length > 0, reason: "prop_mismatch", detail: { type, key: args.key, op, expected: args.value, matched_resources: resources.length, hits: hits.slice(0, 10) } };
  },
};

/** Which predicates need which evidence phases (the runner uses this to skip a
 *  phase no assertion needs, and to pre-flight the engine ops it requires). */
export const PREDICATE_EVIDENCE: Record<string, Array<"snap" | "diff" | "tscn" | "project" | "runtime" | "probe" | "preview">> = {
  count: ["snap"],
  exists: ["snap", "tscn"],
  added_only: ["diff"],
  aabb_within: ["snap"],
  no_overlap: ["snap"],
  on_ground: ["snap"],
  lights: ["snap"],
  camera_current: ["snap"],
  camera_sees: ["probe"],
  collision_under: ["snap"],
  script_attached: ["snap", "tscn"],
  signal_connected: ["tscn"],
  input_action: ["project"],
  main_scene: ["project"],
  runs_clean: ["runtime"],
  runtime_prop: ["runtime"],
  state_machine: ["probe"],
  probe_report: ["probe"],
  frame_not_blank: ["probe"],
  preview_camera_ok: ["preview"],
  no_truncation: ["snap"],
  gold_iou: ["snap"],
  tscn_prop: ["tscn"],
  tscn_resource: ["tscn"],
};

const PREDICATE_SEVERITY: Record<string, Severity> = {
  count: "structural",
  exists: "unsaved",
  added_only: "structural",
  aabb_within: "spatial",
  no_overlap: "spatial",
  on_ground: "spatial",
  lights: "structural",
  camera_current: "structural",
  camera_sees: "spatial",
  collision_under: "structural",
  script_attached: "structural",
  signal_connected: "structural",
  input_action: "structural",
  main_scene: "structural",
  runs_clean: "runtime",
  runtime_prop: "runtime",
  state_machine: "runtime",
  probe_report: "runtime",
  frame_not_blank: "runtime",
  preview_camera_ok: "visual_gate",
  no_truncation: "structural",
  gold_iou: "spatial",
  tscn_prop: "structural",
  tscn_resource: "structural",
};

export function predicateSeverity(predicate: string, reason: string | undefined): Severity {
  if (reason === "evidence_missing") return "evidence_missing";
  if (predicate === "exists" && reason === "no_match") return "structural";
  return PREDICATE_SEVERITY[predicate] ?? "structural";
}

export function evaluateAssertion(spec: AssertionSpec, ev: Evidence): AssertionResult {
  const fn = PREDICATES[spec.predicate];
  let outcome: Outcome;
  if (!fn) {
    outcome = missing("predicate", { detail: `unknown predicate "${spec.predicate}"` });
  } else {
    try {
      outcome = fn(spec.args ?? {}, ev, spec);
    } catch (error) {
      outcome = missing("predicate", { detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const reason = outcome.pass ? undefined : outcome.reason ?? "failed";
  return {
    id: spec.id,
    predicate: spec.predicate,
    required: spec.required,
    pass: outcome.pass,
    severity: outcome.pass ? PREDICATE_SEVERITY[spec.predicate] ?? "structural" : predicateSeverity(spec.predicate, reason),
    ...(reason ? { reason } : {}),
    ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
  };
}

export function evaluateAll(specs: AssertionSpec[], ev: Evidence): AssertionResult[] {
  return specs.map((spec) => evaluateAssertion(spec, ev));
}

/** Task verdict: pass = every required predicate passed; severity = the first
 *  failing required predicate in the fixed order (design §3.1). */
export function taskVerdict(results: AssertionResult[]): { pass: boolean; severity: Severity | null; failed_required: string[] } {
  const failed = results.filter((r) => r.required && !r.pass);
  let severity: Severity | null = null;
  for (const s of SEVERITY_ORDER) {
    if (failed.some((r) => r.severity === s)) {
      severity = s;
      break;
    }
  }
  return { pass: failed.length === 0, severity, failed_required: failed.map((r) => r.id) };
}

// ---------------------------------------------------------------------------
// Evidence coercion from raw op results
// ---------------------------------------------------------------------------

export function snapshotFromResult(result: Record<string, unknown>): Snapshot {
  return {
    snapshot_id: typeof result.snapshot_id === "string" ? result.snapshot_id : undefined,
    scene_path: typeof result.scene_path === "string" ? result.scene_path : undefined,
    total_nodes: typeof result.total_nodes === "number" ? result.total_nodes : undefined,
    truncated: typeof result.truncated === "boolean" ? result.truncated : undefined,
    lights_truncated: result.lights_truncated === true ? true : undefined,
    nodes: Array.isArray(result.nodes) ? (result.nodes as SnapNode[]) : [],
    lights: Array.isArray(result.lights) ? (result.lights as Snapshot["lights"]) : [],
    cameras: Array.isArray(result.cameras) ? (result.cameras as Snapshot["cameras"]) : [],
    environment_fp: typeof result.environment_fp === "string" ? result.environment_fp : undefined,
    counts: (result.counts as Record<string, number>) ?? {},
  };
}

export function diffFromResult(result: Record<string, unknown>): Diff {
  return {
    from_id: typeof result.from_id === "string" ? result.from_id : undefined,
    to_id: typeof result.to_id === "string" ? result.to_id : undefined,
    added: Array.isArray(result.added) ? (result.added as string[]) : [],
    removed: Array.isArray(result.removed) ? (result.removed as string[]) : [],
    changed: Array.isArray(result.changed) ? (result.changed as Diff["changed"]) : [],
    counts_delta: (result.counts_delta as Record<string, number>) ?? {},
    environment_changed: result.environment_changed === true ? true : undefined,
    truncation_warning: typeof result.truncation_warning === "string" ? result.truncation_warning : undefined,
  };
}
