/**
 * Accepted audit items: res://.summer/audit-accept.json.
 *
 * Without it an agent re-judges the same look items (hidden contact faces,
 * inside-corner band overlaps) on every audit. An agent that has
 * looked at an item and judged it fine passes accept: [{key, reason}]; the
 * MCP side writes the entry here (the kernel only reads it, and the audit
 * writes nothing else), and later audits count the item but hide it until
 * its evidence changes materially.
 *
 * - Key: check:path@x,y,z, the world position rounded to 0.1 m (node names
 *   never contain ":" or "@"). A moved piece is a new item.
 * - Evidence: the severity and the issue's magnitude (score) when accepted.
 *   A higher severity, or a score that moves by more than 25% (and 0.005),
 *   makes the entry stale: the item shows again, marked accept_stale.
 * - Errors cannot be accepted. Entries are per scene; the file keeps the
 *   newest 500.
 */
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ISSUE_KEY_PATTERN, type Severity } from "./args.js";
import type { AuditIssue } from "./judge.js";

export const ACCEPT_FILE = join(".summer", "audit-accept.json");
export const ACCEPT_MAX_ENTRIES = 500;
export const ACCEPT_SCORE_CHANGE = 0.25;

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1, look: 2 };

export interface AcceptEntry {
  key: string;
  scene: string;
  reason: string;
  check: string;
  severity: Severity;
  score: number;
  why: string;
  at: string;
}

const tenth = (n: number) => (Math.round(n * 10) / 10 || 0).toFixed(1).replace(/\.0$/, "");

export function issueKey(issue: Pick<AuditIssue, "check" | "path" | "pos">): string {
  return `${issue.check}:${issue.path}@${issue.pos.map(tenth).join(",")}`;
}

export function validIssueKey(key: string): boolean {
  return ISSUE_KEY_PATTERN.test(key);
}

/** The file's entries (the kernel echoes the parsed file as result.accept). */
export function parseAcceptFile(raw: unknown): AcceptEntry[] {
  const doc = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(doc.entries) ? doc.entries : [];
  const out: AcceptEntry[] = [];
  for (const e of list.slice(0, ACCEPT_MAX_ENTRIES * 2)) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const severity = r.severity === "warn" || r.severity === "look" ? r.severity : null;
    if (typeof r.key !== "string" || !validIssueKey(r.key) || typeof r.scene !== "string" || !severity) continue;
    out.push({
      key: r.key,
      scene: r.scene,
      reason: String(r.reason ?? "").slice(0, 200),
      check: String(r.check ?? r.key.split(":")[0]),
      severity,
      score: typeof r.score === "number" && Number.isFinite(r.score) ? r.score : 0,
      why: String(r.why ?? "").slice(0, 160),
      at: String(r.at ?? ""),
    });
  }
  return out;
}

/** Why an accepted item shows again, or null while it still holds. */
export function staleReason(entry: AcceptEntry, issue: AuditIssue): string | null {
  if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[entry.severity]) return `severity rose from ${entry.severity} to ${issue.severity}`;
  const delta = Math.abs(issue.score - entry.score);
  if (delta > Math.max(ACCEPT_SCORE_CHANGE * Math.abs(entry.score), 0.005)) {
    return `evidence changed: magnitude ${Math.round(entry.score * 1000) / 1000} -> ${Math.round(issue.score * 1000) / 1000}`;
  }
  return null;
}

export interface AcceptOutcome {
  /** The new file content (null: nothing to write). */
  entries: AcceptEntry[] | null;
  added: string[];
  refused: Array<{ key: string; why: string }>;
}

/** Merge accept requests for THIS run's issues into the file's entries. */
export function mergeAccepts(existing: readonly AcceptEntry[], requests: ReadonlyArray<{ key: string; reason: string }>, issues: readonly AuditIssue[], scene: string, now = new Date()): AcceptOutcome {
  if (!requests.length) return { entries: null, added: [], refused: [] };
  const byKey = new Map(issues.map((i) => [issueKey(i), i] as const));
  const added: string[] = [];
  const refused: Array<{ key: string; why: string }> = [];
  const fresh: AcceptEntry[] = [];
  for (const req of requests) {
    const issue = byKey.get(req.key);
    if (!issue) {
      refused.push({ key: req.key, why: "no issue with this key in this audit (keys change when a piece moves 5 cm or more)" });
      continue;
    }
    if (issue.severity === "error") {
      refused.push({ key: req.key, why: "errors cannot be accepted: fix it" });
      continue;
    }
    fresh.push({ key: req.key, scene, reason: req.reason.trim().slice(0, 200), check: issue.check, severity: issue.severity, score: issue.score, why: issue.why.slice(0, 160), at: now.toISOString() });
    added.push(req.key);
  }
  if (!fresh.length) return { entries: null, added, refused };
  const keep = existing.filter((e) => !(e.scene === scene && fresh.some((f) => f.key === e.key)));
  const entries = [...keep, ...fresh].slice(-ACCEPT_MAX_ENTRIES);
  return { entries, added, refused };
}

export interface AcceptFilter {
  shown: AuditIssue[];
  accepted: Array<{ issue: AuditIssue; entry: AcceptEntry }>;
  stale: Array<{ issue: AuditIssue; why: string }>;
}

/** Split issues into shown and accepted (stale entries show again). */
export function applyAccepts(issues: readonly AuditIssue[], entries: readonly AcceptEntry[], scene: string): AcceptFilter {
  const mine = new Map(entries.filter((e) => e.scene === scene).map((e) => [e.key, e] as const));
  const shown: AuditIssue[] = [];
  const accepted: AcceptFilter["accepted"] = [];
  const stale: AcceptFilter["stale"] = [];
  for (const issue of issues) {
    const entry = mine.get(issueKey(issue));
    if (!entry || issue.severity === "error") {
      shown.push(issue);
      continue;
    }
    const why = staleReason(entry, issue);
    if (why) {
      stale.push({ issue, why });
      shown.push(issue);
    } else {
      accepted.push({ issue, entry });
    }
  }
  return { shown, accepted, stale };
}

export class AcceptStoreError extends Error {
  constructor(
    readonly reason: "no_project" | "unsafe_path",
    message: string
  ) {
    super(message);
    this.name = "AcceptStoreError";
  }
}

/** Write the entries to <project>/.summer/audit-accept.json: refuses symlinks
 *  at the folder and the file, writes a temp file and renames it. */
export async function writeAcceptFile(projectRoot: string | undefined, entries: readonly AcceptEntry[]): Promise<string> {
  if (!projectRoot || !isAbsolute(projectRoot) || !existsSync(join(projectRoot, "project.godot"))) {
    throw new AcceptStoreError("no_project", "The project folder is not known to this session (no project.godot), so accepted items cannot be saved.");
  }
  const root = resolve(projectRoot);
  const dir = join(root, ".summer");
  await mkdir(dir, { recursive: true });
  const dirInfo = await lstat(dir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new AcceptStoreError("unsafe_path", `${dir} is not a real folder.`);
  const file = join(root, ACCEPT_FILE);
  if (existsSync(file) && (await lstat(file)).isSymbolicLink()) throw new AcceptStoreError("unsafe_path", `${file} is a symlink; refusing to write through it.`);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, note: "summer_scene_audit accepted items (written by accept:[{key, reason}])", entries }, null, 1));
  await rename(tmp, file);
  return file;
}
