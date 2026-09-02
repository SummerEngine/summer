/**
 * Post-processors for engine log/diagnostic payloads before they are returned
 * to the AI model. The engine API stays lossless; the AI-facing surface
 * trims, dedupes, and prioritizes.
 *
 * Two passes:
 *  - dedupe(): collapse consecutive identical messages into one with a
 *    `(×N)` count suffix so a 200-frame `null check` flood reads as one line.
 *  - errorsOnly(): drop info/std lines, keep errors and warnings.
 */
export type LogEntry = {
  message?: string;
  text?: string;
  type?: string;
  severity?: string;
  level?: string;
  timestamp?: string;
  // engine may attach extra fields — preserved verbatim
  [k: string]: unknown;
};

const ERROR_TYPES = new Set(["error", "fatal", "critical"]);
const WARNING_TYPES = new Set(["warning", "warn"]);
const NOISE_TYPES = new Set(["info", "debug", "std", "stdout", "trace", "verbose"]);

export interface FilterOptions {
  /** Drop everything that isn't an error or warning. Default: false. */
  errorsOnly?: boolean;
  /** Drop everything that isn't an error. Default: false. */
  errorsOnlyStrict?: boolean;
  /** Hard cap on returned entries after dedupe. Default: 100. */
  maxEntries?: number;
  /** Skip dedupe — return everything as-is. Default: false. */
  noDedupe?: boolean;
}

export interface FilterSummary {
  totalIn: number;
  totalOut: number;
  duplicatesCollapsed: number;
  droppedByLevel: number;
  truncated: number;
}

export interface FilterResult<T extends LogEntry = LogEntry> {
  entries: T[];
  summary: FilterSummary;
}

function entryKey(e: LogEntry): string {
  // Identical message + same type counts as a duplicate.
  // Timestamps differ by frame, so they're excluded from the key.
  const msg = (e.message ?? e.text ?? "").trim();
  const type = (e.type ?? e.severity ?? e.level ?? "").toLowerCase();
  return `${type}::${msg}`;
}

function entryLevel(e: LogEntry): "error" | "warning" | "noise" | "other" {
  const t = (e.type ?? e.severity ?? e.level ?? "").toLowerCase();
  if (ERROR_TYPES.has(t)) return "error";
  if (WARNING_TYPES.has(t)) return "warning";
  if (NOISE_TYPES.has(t)) return "noise";
  return "other";
}

export function filterAndDedupe<T extends LogEntry>(
  entries: T[],
  opts: FilterOptions = {}
): FilterResult<T> {
  const { errorsOnly = false, errorsOnlyStrict = false, maxEntries = 100, noDedupe = false } = opts;

  const summary: FilterSummary = {
    totalIn: entries.length,
    totalOut: 0,
    duplicatesCollapsed: 0,
    droppedByLevel: 0,
    truncated: 0,
  };

  // Pass 1: level filter
  let kept: T[] = entries;
  if (errorsOnlyStrict || errorsOnly) {
    kept = entries.filter((e) => {
      const level = entryLevel(e);
      if (errorsOnlyStrict) return level === "error";
      return level === "error" || level === "warning";
    });
    summary.droppedByLevel = entries.length - kept.length;
  }

  // Pass 2: dedupe consecutive identical entries
  let deduped: T[];
  if (noDedupe) {
    deduped = kept;
  } else {
    deduped = [];
    let lastKey: string | null = null;
    let lastIdx = -1;
    let runCount = 0;
    for (const e of kept) {
      const key = entryKey(e);
      if (key === lastKey && lastIdx >= 0) {
        runCount += 1;
        const tagged = { ...deduped[lastIdx] } as T & { duplicate_count?: number; message?: string };
        tagged.duplicate_count = runCount;
        const baseMsg = (tagged.message ?? tagged.text ?? "") as string;
        const stripped = baseMsg.replace(/\s*\(×\d+\)\s*$/, "");
        if (tagged.message !== undefined) tagged.message = `${stripped} (×${runCount})`;
        else if (tagged.text !== undefined) (tagged as { text?: string }).text = `${stripped} (×${runCount})`;
        deduped[lastIdx] = tagged;
        summary.duplicatesCollapsed += 1;
      } else {
        deduped.push(e);
        lastKey = key;
        lastIdx = deduped.length - 1;
        runCount = 1;
      }
    }
  }

  // Pass 3: truncate — keep the NEWEST entries. Engine logs are chronological
  // and the failure being debugged is at the end; keeping the head returned
  // startup noise and hid the current error.
  let final = deduped;
  if (deduped.length > maxEntries) {
    final = deduped.slice(-maxEntries);
    summary.truncated = deduped.length - maxEntries;
  }

  summary.totalOut = final.length;
  return { entries: final, summary };
}

const ENTRY_KEYS = ["messages", "errors", "entries", "items", "lines", "output"] as const;

/**
 * Walks a parsed engine response and applies filterAndDedupe to the first
 * recognized log-bearing array. Mutates a clone — the input is not modified.
 *
 * Returns a tuple of [shapedResult, summary] where shapedResult is the same
 * shape as input but with the array replaced and a `_filter` summary
 * appended at the same level so the model can see what was hidden.
 */
export function shapeEngineLogResponse(
  raw: unknown,
  opts: FilterOptions = {}
): { result: unknown; summary: FilterSummary | null } {
  if (!raw || typeof raw !== "object") return { result: raw, summary: null };
  const cloned = JSON.parse(JSON.stringify(raw));
  const summary = applyToFirstArray(cloned, opts);
  return { result: cloned, summary };
}

function applyToFirstArray(node: unknown, opts: FilterOptions): FilterSummary | null {
  if (!node || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === "object") {
        const inner = applyToFirstArray(item, opts);
        if (inner) return inner;
      }
    }
    return null;
  }

  const obj = node as Record<string, unknown>;
  for (const key of ENTRY_KEYS) {
    const arr = obj[key];
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "object") {
      const { entries, summary } = filterAndDedupe(arr as LogEntry[], opts);
      obj[key] = entries;
      obj["_filter"] = summary;
      return summary;
    }
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const inner = applyToFirstArray(v, opts);
      if (inner) return inner;
    }
  }
  return null;
}
