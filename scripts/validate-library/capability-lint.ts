/**
 * Capability lint (CONTRACT.md §6): library entries can never reach the
 * network, credentials, or the package manager, and may not steer agents
 * with hidden or injected text.
 *
 * Runs over every string value in resource.yaml and over markdown bodies
 * (SKILL.md, README.md, reference bodies, style rules, ...).
 *
 * A resource may allowlist a rule via `lint_exceptions: [rule-id]` ONLY
 * together with `lint_exception_reason`; the validator prints these loudly.
 */

export interface LintFinding {
  rule: string;
  /** Where in the resource the text came from, e.g. "SKILL.md:12" or "resource.yaml summary". */
  location: string;
  message: string;
}

export const LINT_RULES = [
  "url-allowlist",
  "install-command",
  "credential-pattern",
  "base64-blob",
  "invisible-unicode",
  "prompt-injection-phrase",
] as const;

export type LintRule = (typeof LINT_RULES)[number];

const URL_RE = /https?:\/\/[^\s)"'<>\]`]+/g;

const INSTALL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bnpm\s+(i|install)\b/i, label: "npm install" },
  { re: /\bpnpm\s+(add|i|install)\b/i, label: "pnpm install" },
  { re: /\byarn\s+(add|global\s+add)\b/i, label: "yarn add" },
  { re: /\bpip3?\s+install\b/i, label: "pip install" },
  { re: /\bbrew\s+install\b/i, label: "brew install" },
  { re: /\bcurl\b[^\n]*\|\s*(ba|z|da)?sh\b/i, label: "curl | sh" },
  { re: /\bwget\s/i, label: "wget" },
];

const NPX_RE = /\bnpx\s+(?:-y\s+|--yes\s+)?([@a-z0-9][@a-z0-9._\/-]*)/gi;

const CREDENTIAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /~\/\.ssh/, label: "~/.ssh" },
  { re: /(?<![\w.-])\.env\b/, label: ".env" },
  { re: /\bAWS_/, label: "AWS_" },
  { re: /\bAPI_KEY/, label: "API_KEY" },
  { re: /\btoken=/i, label: "token=" },
];

const BASE64_RE = /[A-Za-z0-9+/=]{201,}/;

// Zero-width chars (ZWSP, ZWNJ, ZWJ, word-joiner, BOM/ZWNBSP, soft hyphen)
// and bidi controls (LRE..RLO incl. RLO/LRO overrides, isolates LRI..PDI).
const INVISIBLE_RE = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD\u202A-\u202E\u2066-\u2069]/;

const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /ignore\s+previous/i, label: '"ignore previous"' },
  { re: /ignore\s+the\s+user/i, label: '"ignore the user"' },
];

export interface AllowedHost {
  host: string;
  pathPrefix: string | null;
}

export function parseAllowedHosts(allowed: string[]): AllowedHost[] {
  return allowed.map((entry) => {
    const slash = entry.indexOf("/");
    if (slash === -1) return { host: entry.toLowerCase(), pathPrefix: null };
    return {
      host: entry.slice(0, slash).toLowerCase(),
      pathPrefix: entry.slice(slash).replace(/\/+$/, "").toLowerCase(),
    };
  });
}

function urlAllowed(raw: string, allowed: AllowedHost[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false; // unparseable URL-looking string: fail closed
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return allowed.some((a) => {
    if (host !== a.host) return false;
    if (a.pathPrefix === null) return true;
    return path === a.pathPrefix || path.startsWith(`${a.pathPrefix}/`);
  });
}

/**
 * Lint one piece of text. `location` describes where the text lives.
 */
export function lintText(text: string, location: string, allowed: AllowedHost[]): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const match of text.matchAll(URL_RE)) {
    // Strip common trailing punctuation from prose.
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    if (!urlAllowed(raw, allowed)) {
      findings.push({
        rule: "url-allowlist",
        location,
        message: `URL host not in registry/schemas/allowed-hosts.json: ${raw}`,
      });
    }
  }

  for (const { re, label } of INSTALL_PATTERNS) {
    if (re.test(text)) {
      findings.push({ rule: "install-command", location, message: `install command detected (${label})` });
    }
  }

  for (const match of text.matchAll(NPX_RE)) {
    const pkg = match[1].toLowerCase();
    if (pkg !== "summer-engine" && !pkg.startsWith("summer-engine@")) {
      findings.push({ rule: "install-command", location, message: `npx targeting non-summer-engine package: ${match[1]}` });
    }
  }

  for (const { re, label } of CREDENTIAL_PATTERNS) {
    if (re.test(text)) {
      findings.push({ rule: "credential-pattern", location, message: `credential/env pattern detected (${label})` });
    }
  }

  if (BASE64_RE.test(text)) {
    findings.push({ rule: "base64-blob", location, message: "encoded blob detected (>200 consecutive base64 characters)" });
  }

  const invisible = text.match(INVISIBLE_RE);
  if (invisible) {
    const code = invisible[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    findings.push({ rule: "invisible-unicode", location, message: `invisible/bidi unicode character detected (U+${code})` });
  }

  for (const { re, label } of INJECTION_PATTERNS) {
    if (re.test(text)) {
      findings.push({ rule: "prompt-injection-phrase", location, message: `prompt-injection phrase detected (${label})` });
    }
  }

  return findings;
}

/** Collect every string value in a parsed YAML document, with dotted paths. */
export function collectStrings(value: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof value === "string") {
    out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrings(item, `${path}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(v, path === "" ? k : `${path}.${k}`, out);
    }
  }
}
