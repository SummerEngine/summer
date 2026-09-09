/**
 * Example-eval runner interface — the fixed contract (evals/examples/README.md).
 *
 * The real runner (ROADMAP §3.4) implements ExampleRunner. Everything that
 * authors examples during the library migration codes against these types;
 * the interface changing after examples land is a breaking change.
 */

/** One evidence check declared in resource.yaml `evidence.checks`. */
export type EvidenceCheck = "runs" | "screenshot" | "playtest" | "diagnostics-clean";

export interface ExampleUnderTest {
  /** Permanent ID, e.g. "example/stylized-forest-scene" (CONTRACT.md §4). */
  id: string;
  /** Absolute path to library/examples/<slug>/. */
  dir: string;
  /** Engine constraint from resource.yaml compatibility.engine, e.g. ">=4.6". */
  engineConstraint: string;
  /** Exact engine version the evidence was produced on (evidence.engine_version). */
  evidenceEngineVersion: string;
  checks: EvidenceCheck[];
}

export interface CheckResult {
  check: EvidenceCheck;
  passed: boolean;
  /** Human-readable failure detail; empty when passed. */
  detail: string;
}

export interface ExampleResult {
  id: string;
  /** Exact engine version the run executed against (pinned, never "latest"). */
  engineVersion: string;
  /** Headless import pass produced zero errors. */
  imported: boolean;
  /** Bounded headless run produced zero script/debugger errors. */
  ran: boolean;
  checks: CheckResult[];
  passed: boolean;
  durationMs: number;
}

export interface ExampleRunReport {
  engineVersion: string;
  results: ExampleResult[];
  /** True when the runner could not execute at all (no library/, no engine). */
  skipped: boolean;
  skipReason?: string;
}

export interface ExampleRunner {
  /** Discover every example under library/examples/. */
  discover(repoRoot: string): Promise<ExampleUnderTest[]>;
  /** Execute one example against a pinned engine binary. */
  run(example: ExampleUnderTest, engineBinary: string): Promise<ExampleResult>;
  /** Full-suite entry point used by CI. */
  runAll(repoRoot: string): Promise<ExampleRunReport>;
}
