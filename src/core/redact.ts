/**
 * One redaction implementation for every place local diagnostics leave the
 * machine (the MCP lifecycle log, the debug report). Previously duplicated in
 * mcp-log.ts and debug-report.ts, and neither touched free-text `error` /
 * `message` strings that routinely embed a bearer token or an sc_ key.
 */

const SENSITIVE_KEY = /token|secret|password|passwd|authorization|cookie|api[-_]?key/i;

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // "Authorization: Bearer eyJ..." / "Basic dXNlcjpwdw==" inside an error string.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  // key=value / key: value / "key":"value" where the key is a secret name. The
  // scheme word after "Authorization:" is left alone (its credential was
  // already scrubbed above), so the output still says what kind of auth failed.
  [
    /\b(token|secret|password|passwd|authorization|cookie|api[-_]?key)(["']?\s*[:=]\s*["']?)(?!(?:bearer|basic)\b)([^"'\s,;&}]+)/gi,
    "$1$2[REDACTED]",
  ],
  // Known credential shapes: Summer creator tokens, sk- style API keys, JWTs.
  [/\bsc_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED]"],
];

export interface RedactOptions {
  /** Additional key names to blank out entirely (e.g. /hostname/i). */
  extraKeys?: RegExp;
  /** Also scrub credential-shaped substrings out of string VALUES. */
  strings?: boolean;
}

/** Scrub credential-shaped substrings out of free text. */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Deep-copy `value`, blanking any property whose KEY looks sensitive and,
 *  with `strings: true`, scrubbing credential-shaped substrings from values. */
export function redactSensitive(value: unknown, options: RedactOptions = {}): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, options));
  if (typeof value === "string") return options.strings ? redactText(value) : value;
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key) || options.extraKeys?.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redactSensitive(nested, options);
    }
  }
  return out;
}

/** Redact one JSONL log line: structured keys AND free-text values. Non-JSON
 *  lines are scrubbed as text. */
export function redactLogLine(line: string): string {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object") {
      return JSON.stringify(redactSensitive(parsed, { strings: true }));
    }
  } catch {
    // not JSON — fall through
  }
  return redactText(line);
}
