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
  "destructive-command",
] as const;

export type LintRule = (typeof LINT_RULES)[number];

const URL_TAIL = `[^\\s)"'<>\\]\`]+`;

/** http(s) URLs, any letter case (HTTPS://EVIL.COM must not slip past). */
const URL_RE = new RegExp(`\\bhttps?://${URL_TAIL}`, "gi");

/**
 * Non-http schemes are never allowlisted: nothing in the library legitimately
 * points an agent at ftp/sftp/file/smb/ssh/git transports. Godot's own
 * res:// user:// uid:// are resource paths, not URLs, and are not listed.
 */
const NON_HTTP_SCHEME_RE = new RegExp(`\\b(?:ftp|ftps|sftp|file|gopher|smb|ssh|git|telnet|ldap|ldaps)://${URL_TAIL}`, "gi");

/** data: URIs smuggle payloads past a host allowlist; never legitimate here. */
const DATA_URI_RE = /\bdata:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9=-]+)*,/gi;

/**
 * Scheme-relative `//host/path` (browser fills in https). Excludes anything
 * preceded by ":" (res://, https://) or "/" (inside a path).
 */
const PROTOCOL_RELATIVE_RE = new RegExp(`(?<![\\w:/])//([a-z0-9-]+(?:\\.[a-z0-9-]+)+)(/${URL_TAIL.slice(0, -1)}*)?`, "gi");

/**
 * Bare domains with a path ("polyhaven.com/hdris") — a URL the author left the
 * scheme off. Requires a path segment so filenames and prose ("game.io") stay
 * quiet; the allowlist applies as if the scheme were https.
 */
const BARE_DOMAIN_RE = new RegExp(`(?<![\\w./@:-])((?:[a-z0-9-]+\\.)*[a-z0-9-]+\\.(?:com|net|io|dev|sh|xyz|org))(/${URL_TAIL})`, "gi");

const INSTALL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bnpm\s+(i|install)\b/i, label: "npm install" },
  { re: /\bpnpm\s+(add|i|install)\b/i, label: "pnpm install" },
  { re: /\byarn\s+(add|global\s+add)\b/i, label: "yarn add" },
  { re: /\bpip3?\s+install\b/i, label: "pip install" },
  { re: /\bbrew\s+install\b/i, label: "brew install" },
  { re: /\b(cargo|gem|apt(?:-get)?|choco|winget|scoop|bun|deno)\s+(install|add)\b/i, label: "package-manager install/add" },
  { re: /\bbunx\s+[@a-z0-9][@a-z0-9._\/-]*/i, label: "bunx <package>" },
  // `go` alone is an English verb ("then go add a Camera3D"); only the module
  // form `go install host/path@ver` is a command.
  { re: /\bgo\s+(install|get)\s+\S*[./]\S*/i, label: "go install" },
  // pipe-to-shell, including multi-line invocations (line continuations,
  // options on following lines) up to 200 chars after `curl`.
  { re: /\bcurl\b[\s\S]{0,200}?\|\s*(ba|z|da)?sh\b/i, label: "curl | sh" },
  { re: /\bcurl\b[^\n]*&&\s*(ba|z|da)?sh\b/i, label: "curl && sh" },
  { re: /\bwget\s/i, label: "wget" },
];

/**
 * npx execution of a third-party package. Group 1 = a forcing flag (-y/--yes),
 * group 2 = the target token. Only flagged when the token is a plausible
 * package name — scoped (@scope/name) or containing a hyphen, dot, slash, or
 * digit — or when the forcing flag makes it an unambiguous exec regardless.
 * Bare dictionary words after "npx" in prose ("npx to resolve", "old npx
 * package material") are not commands and must not fire this rule.
 */
const NPX_RE = /\bnpx\s+(-y\s+|--yes\s+)?([@a-z0-9][@a-z0-9._\/-]*)/gi;
const NPX_PACKAGE_LIKE_RE = /[@/.\d-]/;

const CREDENTIAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /~\/\.ssh/, label: "~/.ssh" },
  { re: /~\/\.(aws|npmrc|config\/gh|docker|kube)\b/, label: "~/.aws|.npmrc|.config/gh|.docker|.kube" },
  { re: /(?<![\w.-])\.env\b/, label: ".env" },
  { re: /\bAWS_/, label: "AWS_" },
  { re: /\bAPI_KEY/, label: "API_KEY" },
  // Any UPPER_CASE identifier containing SECRET/PASSWORD/PASSWD/TOKEN that is
  // being assigned (GH_TOKEN=, NPM_TOKEN:, MY_SECRET =). Broader than a bare
  // "TOKEN=" so prefixed env names do not slip through.
  { re: /\b[A-Z0-9_]*(SECRET|PASSWORD|PASSWD|TOKEN)[A-Z0-9_]*\s*[:=]/, label: "SECRET|PASSWORD|PASSWD|TOKEN assignment" },
  { re: /\btoken=/i, label: "token=" },
  { re: /\bBearer\s+\S/, label: "Bearer <credential>" },
];

const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(~|\/|\$HOME)/, label: "rm -rf on ~, /, or $HOME" },
  { re: /\bssh\s+\S+@/, label: "ssh user@host" },
];

/**
 * Encoded blobs. Threshold 160 for the standard and URL-safe alphabets; a run
 * must contain both a letter and a digit so a 160-char markdown rule
 * ("-----") or underscore line is not a blob. Two adjacent lines that are each
 * pure-alphabet and together exceed the threshold are also a blob (wrapped
 * base64 is still base64).
 */
export const BASE64_MIN_LENGTH = 160;
const BASE64_STD_RE = /[A-Za-z0-9+/=]{160,}/g;
const BASE64_URLSAFE_RE = /[A-Za-z0-9_-]{160,}/g;
const BASE64_LINE_RE = /^[A-Za-z0-9+/=_-]+$/;
const HAS_LETTER_AND_DIGIT_RE = /(?=.*[A-Za-z])(?=.*[0-9])/;

// Zero-width chars (ZWSP, ZWNJ, ZWJ, word-joiner, BOM/ZWNBSP, soft hyphen),
// bidi controls (LRE..RLO, isolates LRI..PDI), invisible math operators
// (U+2061..2064), Mongolian vowel separator, Hangul fillers, and the
// U+E0000..E007F tag block (used to smuggle ASCII invisibly).
const INVISIBLE_RE = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD\u202A-\u202E\u2066-\u2069\u2061-\u2064\u180E\u3164\uFFA0\u{E0000}-\u{E007F}]/u;
// Variation selector-16 is legitimate directly after an emoji/symbol base
// (⚠️); standing alone (after a letter, space, or punctuation) it is invisible.
const STRAY_VS16_RE = /(?<![\p{Extended_Pictographic}\p{S}\d#*\u20E3\uFE0F])\uFE0F/u;

const INJECTION_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // "(the)" optional so "ignore the above" fires; a following hyphen means a
  // compound like "previous-frame velocity", which is game-dev prose.
  { re: /\bignore\W+(all\W+)?(the\W+)?(previous|prior|above|earlier)\b(?!-)/i, label: '"ignore (all) previous/prior/above/earlier"' },
  { re: /\bignore\s+the\s+user/i, label: '"ignore the user"' },
  { re: /\bignore what the user\b/i, label: '"ignore what the user"' },
  { re: /\bignore your system prompt\b/i, label: '"ignore your system prompt"' },
  { re: /\bdisregard\b.{0,40}\b(instructions|prompt|rules)\b/i, label: '"disregard ... instructions/prompt/rules"' },
  { re: /\bnew instructions\s*:/i, label: '"new instructions:"' },
  // "do not tell the user" is ordinary game-dev guidance ("do not tell the
  // user a shot is done before the job completes"); the injection form hides
  // instructions/prompt/hidden text from the user.
  {
    re: /\bdo not tell the user\b(?=.{0,40}\b(about|instructions?|prompt|rules?|hidden|secret|this (message|file|section|note|text|comment))\b)/i,
    label: '"do not tell the user about/instructions/prompt/hidden ..."',
  },
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
  // Loopback URLs (any port) are always allowed: skills legitimately document
  // bundled local servers (e.g. a preview server the skill itself starts).
  // A loopback URL cannot exfiltrate data or fetch remote content — it only
  // reaches software already running on the user's own machine.
  if (host === "localhost" || host === "127.0.0.1") return true;
  const path = url.pathname.toLowerCase();
  return allowed.some((a) => {
    if (host !== a.host) return false;
    if (a.pathPrefix === null) return true;
    return path === a.pathPrefix || path.startsWith(`${a.pathPrefix}/`);
  });
}

function stripTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, "");
}

/**
 * Lint one piece of text. `location` describes where the text lives.
 * HTML comments are NOT stripped: text hidden from a markdown renderer is
 * exactly where injected instructions go, so it is linted like any other text.
 */
export function lintText(text: string, location: string, allowed: AllowedHost[]): LintFinding[] {
  const findings: LintFinding[] = [];

  // URLs. Scheme URLs are matched first and then blanked so the bare-domain
  // and scheme-relative passes do not re-report their hosts.
  let remaining = text;
  for (const match of text.matchAll(URL_RE)) {
    const raw = stripTrailingPunctuation(match[0]);
    if (!urlAllowed(raw, allowed)) {
      findings.push({ rule: "url-allowlist", location, message: `URL host not in registry/schemas/allowed-hosts.json: ${raw}` });
    }
  }
  remaining = remaining.replace(URL_RE, (m) => " ".repeat(m.length));
  for (const match of remaining.matchAll(NON_HTTP_SCHEME_RE)) {
    findings.push({ rule: "url-allowlist", location, message: `non-http URL scheme is never allowed: ${stripTrailingPunctuation(match[0])}` });
  }
  remaining = remaining.replace(NON_HTTP_SCHEME_RE, (m) => " ".repeat(m.length));
  for (const match of remaining.matchAll(DATA_URI_RE)) {
    findings.push({ rule: "url-allowlist", location, message: `data: URI detected: ${match[0].slice(0, 40)}` });
  }
  for (const match of remaining.matchAll(PROTOCOL_RELATIVE_RE)) {
    const raw = stripTrailingPunctuation(`https:${match[0]}`);
    if (!urlAllowed(raw, allowed)) {
      findings.push({ rule: "url-allowlist", location, message: `scheme-relative URL host not in allowlist: ${stripTrailingPunctuation(match[0])}` });
    }
  }
  remaining = remaining.replace(PROTOCOL_RELATIVE_RE, (m) => " ".repeat(m.length));
  for (const match of remaining.matchAll(BARE_DOMAIN_RE)) {
    const raw = stripTrailingPunctuation(`https://${match[0]}`);
    if (!urlAllowed(raw, allowed)) {
      findings.push({ rule: "url-allowlist", location, message: `bare domain URL host not in allowlist: ${stripTrailingPunctuation(match[0])}` });
    }
  }

  for (const { re, label } of INSTALL_PATTERNS) {
    if (re.test(text)) {
      findings.push({ rule: "install-command", location, message: `install command detected (${label})` });
    }
  }

  for (const match of text.matchAll(NPX_RE)) {
    const forced = match[1] !== undefined;
    const pkg = match[2].toLowerCase();
    if (pkg === "summer-engine" || pkg.startsWith("summer-engine@")) continue;
    if (!forced && !NPX_PACKAGE_LIKE_RE.test(pkg)) continue; // prose, not a command
    findings.push({ rule: "install-command", location, message: `npx targeting non-summer-engine package: ${match[2]}` });
  }

  for (const { re, label } of CREDENTIAL_PATTERNS) {
    if (re.test(text)) {
      findings.push({ rule: "credential-pattern", location, message: `credential/env pattern detected (${label})` });
    }
  }

  for (const { re, label } of DESTRUCTIVE_PATTERNS) {
    if (re.test(text)) {
      findings.push({ rule: "destructive-command", location, message: `destructive command detected (${label})` });
    }
  }

  if (detectEncodedBlob(text)) {
    findings.push({ rule: "base64-blob", location, message: `encoded blob detected (>=${BASE64_MIN_LENGTH} consecutive base64/base64url characters, possibly wrapped over two lines)` });
  }

  const invisible = text.match(INVISIBLE_RE) ?? text.match(STRAY_VS16_RE);
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

function isBlobRun(run: string): boolean {
  return run.length >= BASE64_MIN_LENGTH && HAS_LETTER_AND_DIGIT_RE.test(run);
}

/** Exported for tests: standard + URL-safe alphabets, plus two-line wraps. */
export function detectEncodedBlob(text: string): boolean {
  for (const re of [BASE64_STD_RE, BASE64_URLSAFE_RE]) {
    for (const match of text.matchAll(re)) {
      if (isBlobRun(match[0])) return true;
    }
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    if (a.length > 0 && b.length > 0 && BASE64_LINE_RE.test(a) && BASE64_LINE_RE.test(b) && isBlobRun(a + b)) {
      return true;
    }
  }
  return false;
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
