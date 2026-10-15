/**
 * Release author check: every commit since the last npm release must come from
 * mathias-heide or frozaken, or be accepted in release-reviewed.json. The repo
 * is public, so outside code must never reach npm unseen. cli.ts runs this
 * first in prepublishOnly; docs/RELEASING.md describes it.
 *
 * Who a commit came from is decided by GitHub, never by commit emails (anyone
 * can fake those):
 * - A commit that came through a pull request belongs to the PR's author.
 * - A direct push belongs to the commit's author and committer logins; only
 *   people with write access can push.
 * Claude (claude / claude[bot]) counts only when the push was made under one
 * of the two accounts. A PR opened by Claude itself is outside.
 */

export const ALLOWED_LOGINS = ["mathias-heide", "frozaken"];
const CLAUDE_LOGINS = ["claude", "claude[bot]"];
// GitHub's committer for web UI edits; the author is then the signed-in user.
const WEB_FLOW = "web-flow";

export const ESCAPE_ENV = "SUMMER_RELEASE_AUTHORS_REVIEWED";
export const REVIEWED_FILE = "release-reviewed.json";

export interface LocalCommit {
  sha: string;
  title: string;
}

export interface PullRef {
  number: number;
  login: string | null;
  merged: boolean;
}

export interface CommitLogins {
  author: string | null;
  committer: string | null;
}

/** GitHub lookups. Throw when GitHub cannot be asked (not signed in, down). */
export interface GitHubLookup {
  /** PRs that contain the commit; null when GitHub does not have the commit. */
  pullsForCommit(sha: string): Promise<PullRef[] | null>;
  commitLogins(sha: string): Promise<CommitLogins>;
}

export interface ReviewedEntry {
  sha: string;
  note: string;
}

export interface CommitVerdict {
  sha: string;
  title: string;
  status: "allowed" | "reviewed" | "outside";
  pr: number | null;
  login: string | null;
  reason: string;
}

export interface CheckReport {
  status: "pass" | "outside" | "unavailable" | "skipped";
  verdicts: CommitVerdict[];
  message: string;
}

export interface CheckInput {
  commits: LocalCommit[];
  reviewed: ReviewedEntry[];
  github: GitHubLookup;
  /** "summer-engine@3.8.0 (0a4b6d9)" — where the range starts, for messages. */
  baseLabel: string;
  env?: Record<string, string | undefined>;
  concurrency?: number;
}

const isAllowed = (login: string | null) => login !== null && ALLOWED_LOGINS.includes(login.toLowerCase());
const isClaude = (login: string | null) => login !== null && CLAUDE_LOGINS.includes(login.toLowerCase());

export async function classifyCommit(
  commit: LocalCommit,
  reviewed: Map<string, ReviewedEntry>,
  github: GitHubLookup,
): Promise<CommitVerdict> {
  const base = { sha: commit.sha, title: commit.title };
  const accepted = reviewed.get(commit.sha);
  if (accepted) return { ...base, status: "reviewed", pr: null, login: null, reason: accepted.note };

  const pulls = await github.pullsForCommit(commit.sha);
  if (pulls === null) {
    return { ...base, status: "outside", pr: null, login: null, reason: "GitHub does not have this commit; push it first" };
  }
  const merged = pulls.filter((p) => p.merged);
  if (merged.length > 0) {
    const outsidePr = merged.find((p) => !isAllowed(p.login));
    if (outsidePr) {
      return { ...base, status: "outside", pr: outsidePr.number, login: outsidePr.login, reason: "pull request by an outside account" };
    }
    return { ...base, status: "allowed", pr: merged[0].number, login: merged[0].login, reason: "pull request" };
  }

  const { author, committer } = await github.commitLogins(commit.sha);
  const pushedByOwner =
    (isAllowed(author) && (isAllowed(committer) || committer === WEB_FLOW)) ||
    (isClaude(author) && isAllowed(committer));
  if (pushedByOwner) return { ...base, status: "allowed", pr: null, login: author, reason: "direct push" };
  return {
    ...base,
    status: "outside",
    pr: null,
    login: author,
    reason: `direct push, author ${author ?? "unknown"}, committer ${committer ?? "unknown"}`,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function checkReleaseAuthors(input: CheckInput): Promise<CheckReport> {
  const env = input.env ?? {};
  if (env[ESCAPE_ENV] === "1") {
    return {
      status: "skipped",
      verdicts: [],
      message: `Release author check SKIPPED: ${ESCAPE_ENV}=1 says Mathias or Frozaken checked every commit since ${input.baseLabel} by hand.`,
    };
  }

  const reviewed = new Map(input.reviewed.map((entry) => [entry.sha, entry]));
  let verdicts: CommitVerdict[];
  try {
    verdicts = await mapLimit(input.commits, input.concurrency ?? 8, (c) => classifyCommit(c, reviewed, input.github));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      verdicts: [],
      message: [
        "Release blocked: could not ask GitHub who wrote the commits since the last release.",
        `  ${reason}`,
        "Fix: sign in with `gh auth login` (or wait for GitHub), then publish again.",
        `If Mathias or Frozaken checked every commit since ${input.baseLabel} by hand: ${ESCAPE_ENV}=1 npm publish`,
      ].join("\n"),
    };
  }

  const outside = verdicts.filter((v) => v.status === "outside");
  if (outside.length === 0) {
    const reviewedCount = verdicts.filter((v) => v.status === "reviewed").length;
    return {
      status: "pass",
      verdicts,
      message: `Release authors OK: ${verdicts.length} commit(s) since ${input.baseLabel}, all from ${ALLOWED_LOGINS.join(" or ")}${reviewedCount ? ` or accepted in ${REVIEWED_FILE} (${reviewedCount})` : ""}.`,
    };
  }

  const lines = outside.map(
    (v) => `  ${v.sha.slice(0, 9)}  ${v.pr ? `PR #${v.pr}` : "no PR"}  ${v.login ?? "unknown"}  ${v.title}  (${v.reason})`,
  );
  return {
    status: "outside",
    verdicts,
    message: [
      `Release blocked: ${outside.length} commit(s) since ${input.baseLabel} did not come from ${ALLOWED_LOGINS.join(" or ")}.`,
      ...lines,
      `Read each one. To accept it, add its full SHA with a note (who accepted it, when) to ${REVIEWED_FILE}`,
      "in a commit by mathias-heide or frozaken, merge that to main, and publish again.",
    ].join("\n"),
  };
}

/** Parse release-reviewed.json. Throws on anything but full SHAs with a note. */
export function parseReviewed(text: string): ReviewedEntry[] {
  const data = JSON.parse(text) as { reviewed?: unknown };
  if (!Array.isArray(data.reviewed)) throw new Error(`${REVIEWED_FILE}: expected { "reviewed": [...] }`);
  return data.reviewed.map((entry: { sha?: unknown; note?: unknown }, i) => {
    if (typeof entry?.sha !== "string" || !/^[0-9a-f]{40}$/.test(entry.sha)) {
      throw new Error(`${REVIEWED_FILE}: entry ${i} needs the full 40-character lowercase SHA`);
    }
    if (typeof entry.note !== "string" || entry.note.trim() === "") {
      throw new Error(`${REVIEWED_FILE}: entry ${i} needs a note saying who accepted it and when`);
    }
    return { sha: entry.sha, note: entry.note };
  });
}
