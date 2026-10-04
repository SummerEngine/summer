/**
 * The compact audit result: counts per check, time per check, and ONE page of
 * issues sorted by severity, never more than SUMMARY_CAP_BYTES of JSON. Agents
 * could not read the 61 KB and 93 KB results older tools produced, so the cap
 * is enforced here by construction: issues are added while they fit, and the
 * result names the offset of the next page.
 */
import { AUDIT_CHECKS, SEVERITIES, type AuditCheck, type Severity } from "./args.js";
import type { AuditIssue } from "./judge.js";

export const SUMMARY_CAP_BYTES = 5000;

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, look: 2 };
const CHECK_RANK = new Map<string, number>(AUDIT_CHECKS.map((c, i) => [c, i]));

export function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Severity first, then the check's place in the list, then magnitude. */
export function sortIssues(issues: readonly AuditIssue[]): AuditIssue[] {
  return [...issues].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (CHECK_RANK.get(a.check) ?? 99) - (CHECK_RANK.get(b.check) ?? 99) ||
      b.score - a.score ||
      a.path.localeCompare(b.path)
  );
}

export function filterIssues(issues: readonly AuditIssue[], minSeverity: Severity = "look"): AuditIssue[] {
  const limit = SEVERITY_RANK[minSeverity];
  return issues.filter((i) => SEVERITY_RANK[i.severity] <= limit);
}

/** Per check: { error: n, warn: n, look: n } without zeros; checks that ran
 *  and found nothing are listed in `clean`. */
export function countIssues(issues: readonly AuditIssue[], ran: readonly AuditCheck[]): { counts: Record<string, Partial<Record<Severity, number>>>; clean: AuditCheck[] } {
  const counts: Record<string, Partial<Record<Severity, number>>> = {};
  for (const i of issues) {
    const c = (counts[i.check] ??= {});
    c[i.severity] = (c[i.severity] ?? 0) + 1;
  }
  const ordered: Record<string, Partial<Record<Severity, number>>> = {};
  for (const check of AUDIT_CHECKS) {
    if (!counts[check]) continue;
    const c: Partial<Record<Severity, number>> = {};
    for (const s of SEVERITIES) if (counts[check]![s]) c[s] = counts[check]![s];
    ordered[check] = c;
  }
  return { counts: ordered, clean: ran.filter((c) => !counts[c]) };
}

export interface CompactIssue {
  n: number;
  check: AuditCheck;
  sev: Severity;
  path: string;
  pos: readonly number[];
  why: string;
  ev: Record<string, unknown>;
  next: string;
}

export function compactIssue(issue: AuditIssue, n: number): CompactIssue {
  return { n, check: issue.check, sev: issue.severity, path: issue.path, pos: issue.pos, why: issue.why, ev: issue.ev, next: issue.next };
}

/** A single issue that alone is too big for the page: cut its prose. */
function shrink(issue: CompactIssue, budget: number): CompactIssue {
  let out: CompactIssue = { ...issue, why: issue.why.slice(0, 200), next: issue.next.slice(0, 160) };
  if (bytes(out) <= budget) return out;
  const ev: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(issue.ev).slice(0, 4)) ev[k] = typeof v === "string" ? v.slice(0, 80) : v;
  out = { ...out, ev };
  if (bytes(out) <= budget) return out;
  return { ...out, why: out.why.slice(0, 100), ev: {}, next: out.next.slice(0, 80) };
}

export interface PageInput {
  base: Record<string, unknown>;
  issues: readonly AuditIssue[];
  offset: number;
  limit: number;
  cap?: number;
}

export interface Page {
  body: Record<string, unknown>;
  shown: CompactIssue[];
}

/**
 * One page: `base` (counts, timings, notes) plus issues[offset..] added one
 * at a time while the JSON stays within `cap`. `next_offset` names where the
 * next page starts; `trimmed_to_fit` says the byte cap (not `limit`) ended
 * the page.
 */
export function buildPage({ base, issues, offset, limit, cap = SUMMARY_CAP_BYTES }: PageInput): Page {
  const start = Math.min(Math.max(0, offset), issues.length);
  const shown: CompactIssue[] = [];
  const frame = (list: CompactIssue[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...base,
    matching: issues.length,
    offset: start,
    shown: list.length,
    ...extra,
    issues: list,
  });
  let trimmed = false;
  for (let i = start; i < issues.length && shown.length < limit; i++) {
    const candidate = compactIssue(issues[i]!, i + 1);
    // Fit against the largest tail the page can end with (a next offset AND
    // the trimmed flag), so adding the flag afterwards never breaks the cap.
    const tail = { next_offset: issues.length, trimmed_to_fit: true };
    if (bytes(frame([...shown, candidate], tail)) <= cap) {
      shown.push(candidate);
      continue;
    }
    if (shown.length === 0) {
      const room = cap - bytes(frame([], tail)) - 8;
      const small = shrink(candidate, room);
      if (bytes(frame([small], tail)) <= cap) {
        shown.push(small);
        trimmed = true;
        continue;
      }
    }
    trimmed = true;
    break;
  }
  const end = start + shown.length;
  const body = frame(shown, {
    next_offset: end < issues.length ? end : null,
    ...(trimmed ? { trimmed_to_fit: true } : {}),
  });
  // A base so large that nothing fits (should not happen): drop the notes.
  if (bytes(body) > cap && Array.isArray(body.notes)) {
    const lean = { ...body, notes: (body.notes as unknown[]).slice(0, 1) };
    return { body: lean, shown };
  }
  return { body, shown };
}

/** Kernel stage timings -> time per check (ms), plus setup and totals. */
export function timingPerCheck(ms: Record<string, unknown> | undefined, extra: Record<string, number>): Record<string, number | string> {
  const m = (k: string) => (typeof ms?.[k] === "number" ? (ms[k] as number) : 0);
  const out: Record<string, number | string> = {
    setup: Math.round((m("collect") + m("manifests_roles") + m("mesh_pass") + m("physics_build")) * 10) / 10,
    setup_parts: `walk ${Math.round(m("collect"))} + roles ${Math.round(m("manifests_roles"))} + meshes ${Math.round(m("mesh_pass"))} + physics ${Math.round(m("physics_build"))}`,
  };
  const map: Array<[string, string]> = [
    ["through_hole", "through_hole"],
    ["floor_gap", "floor_gap"],
    ["floating_sunken", "floating+sunken"],
    ["interpenetration", "interpenetration"],
    ["mount_gap", "mount_gap"],
    ["orientation", "orientation"],
    ["uv_stretch", "uv_stretch"],
    ["insert_host", "insert_host"],
    ["lights", "lights"],
    ["resource", "resource"],
    ["poses", "framing"],
  ];
  for (const [stage, name] of map) if (typeof ms?.[stage] === "number") out[name] = ms[stage] as number;
  out.editor_total = m("total");
  return { ...out, ...extra };
}
