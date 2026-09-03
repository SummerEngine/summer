/**
 * Task suite loading + validation (design §1.1): one YAML per task under
 * tasks/<tier>/<id>.yaml. Validation is what `--dry-run` runs per PR — no
 * engine, no model: shape, known predicates, unique assertion ids, fixture
 * present, skills_expected resolvable in the compiled registry index.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PREDICATES, type AssertionSpec, type GoldNode } from "./assert.ts";

export interface TaskBudget {
  wall_clock_s: number;
  max_tool_calls: number;
}

export interface TaskSpec {
  id: string;
  tier: string;
  title: string;
  prompt: string;
  fixture: string;
  /** The scene the agent works in (opened by the harness before the agent phase). */
  scene: string;
  budget: TaskBudget;
  skills_expected: string[];
  capture: string[];
  assertions: AssertionSpec[];
  probe_snippet?: string;
  gold?: GoldNode[];
  /** Seconds the runtime phase keeps the game alive (max over runs_clean seconds). */
  file: string;
}

export const TASK_ID_PATTERN = /^T\d+\.\d+-[a-z0-9][a-z0-9-]*$/;

export function loadTaskFile(file: string): TaskSpec {
  const raw = parseYaml(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error(`${file}: not a mapping`);
  const errors = validateTaskShape(raw, file);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const assertions = (raw.assertions as Array<Record<string, unknown>>).map((a) => ({
    id: String(a.id),
    predicate: String(a.predicate),
    args: (a.args as Record<string, unknown>) ?? {},
    required: a.required !== false,
    ...(typeof a.note === "string" ? { note: a.note } : {}),
  }));
  const budget = (raw.budget as Partial<TaskBudget>) ?? {};
  return {
    id: String(raw.id),
    tier: String(raw.tier),
    title: String(raw.title),
    prompt: String(raw.prompt),
    fixture: String(raw.fixture),
    scene: typeof raw.scene === "string" ? raw.scene : "res://main.tscn",
    budget: { wall_clock_s: budget.wall_clock_s ?? 480, max_tool_calls: budget.max_tool_calls ?? 25 },
    skills_expected: Array.isArray(raw.skills_expected) ? (raw.skills_expected as string[]) : [],
    capture: Array.isArray(raw.capture) ? (raw.capture as string[]) : [],
    assertions,
    ...(typeof raw.probe_snippet === "string" ? { probe_snippet: raw.probe_snippet } : {}),
    ...(Array.isArray(raw.gold) ? { gold: raw.gold as GoldNode[] } : {}),
    file,
  };
}

/** Shape errors, human-readable, prefixed with the file. Empty = valid. */
export function validateTaskShape(raw: Record<string, unknown>, file: string): string[] {
  const errors: string[] = [];
  const err = (m: string) => errors.push(`${basename(file)}: ${m}`);
  if (typeof raw.id !== "string" || !TASK_ID_PATTERN.test(raw.id)) err(`id must match ${TASK_ID_PATTERN} (got ${JSON.stringify(raw.id)})`);
  if (typeof raw.id === "string" && basename(file) !== `${raw.id}.yaml`) err(`file name must be <id>.yaml (id ${raw.id})`);
  if (typeof raw.tier !== "string" || !/^T\d+$/.test(raw.tier)) err("tier must be T<n>");
  if (typeof raw.id === "string" && typeof raw.tier === "string" && !raw.id.startsWith(`${raw.tier}.`)) err(`id ${raw.id} does not belong to tier ${raw.tier}`);
  if (typeof raw.title !== "string" || raw.title.length === 0) err("title is required");
  if (typeof raw.prompt !== "string" || raw.prompt.trim().length === 0) err("prompt (verbatim user text) is required");
  if (typeof raw.fixture !== "string" || !/^[a-z0-9-]+$/.test(raw.fixture)) err("fixture must be a fixture directory name");
  if (raw.scene !== undefined && (typeof raw.scene !== "string" || !raw.scene.startsWith("res://"))) err("scene must be a res:// path");
  const budget = raw.budget as Record<string, unknown> | undefined;
  if (budget && (typeof budget.wall_clock_s !== "number" || typeof budget.max_tool_calls !== "number")) err("budget needs numeric wall_clock_s and max_tool_calls");
  if (raw.skills_expected !== undefined && (!Array.isArray(raw.skills_expected) || raw.skills_expected.some((s) => typeof s !== "string" || !s.startsWith("skill/")))) {
    err("skills_expected must be a list of skill/<slug> ids");
  }
  if (!Array.isArray(raw.assertions) || raw.assertions.length === 0) {
    err("assertions must be a non-empty list");
    return errors;
  }
  const ids = new Set<string>();
  let requiredCount = 0;
  for (const [i, a] of (raw.assertions as unknown[]).entries()) {
    if (!a || typeof a !== "object") {
      err(`assertions[${i}] is not a mapping`);
      continue;
    }
    const spec = a as Record<string, unknown>;
    if (typeof spec.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(spec.id)) err(`assertions[${i}].id must be kebab-case`);
    else if (ids.has(spec.id)) err(`duplicate assertion id ${spec.id}`);
    else ids.add(spec.id);
    if (typeof spec.predicate !== "string" || !(spec.predicate in PREDICATES)) err(`assertions[${i}] (${String(spec.id)}) names unknown predicate ${JSON.stringify(spec.predicate)}`);
    if (spec.args !== undefined && (typeof spec.args !== "object" || Array.isArray(spec.args))) err(`assertions[${i}].args must be a mapping`);
    if (spec.required !== undefined && typeof spec.required !== "boolean") err(`assertions[${i}].required must be boolean`);
    if (spec.required !== false) requiredCount++;
    if (spec.predicate === "gold_iou" && !Array.isArray(raw.gold)) err(`assertions[${i}] uses gold_iou but the task has no gold list`);
  }
  if (requiredCount === 0) err("at least one required assertion (an eval that cannot fail is documentation)");
  if (raw.probe_snippet !== undefined && typeof raw.probe_snippet !== "string") err("probe_snippet must be a GDScript string");
  return errors;
}

export function taskFiles(tasksDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".yaml")) out.push(p);
    }
  };
  if (existsSync(tasksDir)) walk(tasksDir);
  return out;
}

export function loadTasks(tasksDir: string): TaskSpec[] {
  const tasks = taskFiles(tasksDir).map(loadTaskFile);
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) throw new Error(`duplicate task id ${t.id}`);
    seen.add(t.id);
  }
  return tasks;
}

/** Cross-file checks for --dry-run: fixtures exist, skills_expected resolve. */
export function crossCheckTasks(tasks: TaskSpec[], fixturesDir: string, registryIndexPath: string): string[] {
  const errors: string[] = [];
  let known: Set<string> | null = null;
  if (existsSync(registryIndexPath)) {
    try {
      const idx = JSON.parse(readFileSync(registryIndexPath, "utf8")) as { resources?: Array<{ id?: string }> };
      known = new Set((idx.resources ?? []).map((r) => r.id).filter((id): id is string => typeof id === "string"));
    } catch {
      known = null;
    }
  }
  for (const t of tasks) {
    const fixture = join(fixturesDir, t.fixture);
    if (!existsSync(join(fixture, "project.godot"))) errors.push(`${t.id}: fixture ${t.fixture} has no project.godot under ${fixturesDir}`);
    else if (!existsSync(join(fixture, t.scene.replace("res://", "")))) errors.push(`${t.id}: fixture ${t.fixture} lacks scene ${t.scene}`);
    if (known) {
      for (const id of t.skills_expected) if (!known.has(id)) errors.push(`${t.id}: skills_expected ${id} is not in the registry index`);
    }
  }
  return errors;
}
