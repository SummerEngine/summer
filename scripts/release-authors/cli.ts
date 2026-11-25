#!/usr/bin/env node
/**
 * npm run check:release-authors — first step of prepublishOnly. Fails the
 * publish when a commit since the last npm release came from outside
 * mathias-heide / frozaken and is not in release-reviewed.json. See check.ts.
 *
 * Range: `npm view summer-engine@latest gitHead`..HEAD; if npm has no usable
 * gitHead, the newest v* tag before HEAD (said out loud). GitHub answers come
 * from `gh api`, so gh must be signed in. Fails closed when it cannot ask;
 * SUMMER_RELEASE_AUTHORS_REVIEWED=1 is the manual override.
 *
 * Usage: node scripts/release-authors/cli.ts [--from <ref>]
 *   --from <ref>  check <ref>..HEAD instead of the last npm release (dry tries).
 *
 * Requires Node >= 22.18 (native TypeScript type stripping), same as
 * scripts/validate-library/cli.ts.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ESCAPE_ENV,
  REVIEWED_FILE,
  checkReleaseAuthors,
  parseReviewed,
  type GitHubLookup,
  type LocalCommit,
} from "./check.ts";

const run = promisify(execFile);
const REPO = "SummerEngine/summer";
const PACKAGE = "summer-engine";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function isAncestorCommit(sha: string): Promise<boolean> {
  try {
    await git("merge-base", "--is-ancestor", sha, "HEAD");
    return true;
  } catch {
    return false;
  }
}

async function releaseBase(): Promise<{ sha: string; label: string }> {
  const fromIndex = process.argv.indexOf("--from");
  if (fromIndex !== -1) {
    const ref = process.argv[fromIndex + 1];
    return { sha: await git("rev-parse", `${ref}^{commit}`), label: ref };
  }
  let why: string;
  try {
    const { stdout } = await run("npm", ["view", `${PACKAGE}@latest`, "gitHead", "version", "--json"], { cwd: repoRoot });
    const { gitHead, version } = JSON.parse(stdout) as { gitHead?: string; version?: string };
    if (gitHead && (await isAncestorCommit(gitHead))) return { sha: gitHead, label: `${PACKAGE}@${version} (${gitHead.slice(0, 9)})` };
    why = gitHead ? `its gitHead ${gitHead.slice(0, 9)} is not in this checkout's history` : "it lists no gitHead";
  } catch (error) {
    why = `npm view failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }
  const tag = await git("describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD").catch(() => "");
  if (!tag) throw new Error(`cannot find the last release: npm ${why}, and no v* tag is in HEAD's history.`);
  console.warn(`Release author check: cannot use the npm release (${why}); checking from tag ${tag} instead.`);
  return { sha: await git("rev-parse", `${tag}^{commit}`), label: `tag ${tag}` };
}

async function ghApi(endpoint: string): Promise<unknown | null> {
  try {
    const { stdout } = await run("gh", ["api", endpoint], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    if (/\(HTTP 4(04|22)\)/.test(stderr)) return null;
    const detail = (error as NodeJS.ErrnoException).code === "ENOENT" ? "gh is not installed" : stderr.trim().split("\n")[0];
    throw new Error(`gh api ${endpoint}: ${detail || "failed"}`);
  }
}

const github: GitHubLookup = {
  async pullsForCommit(sha) {
    const pulls = (await ghApi(`repos/${REPO}/commits/${sha}/pulls`)) as
      | { number: number; user: { login: string } | null; merged_at: string | null }[]
      | null;
    if (pulls === null) return null;
    return pulls.map((p) => ({ number: p.number, login: p.user?.login ?? null, merged: p.merged_at !== null }));
  },
  async commitLogins(sha) {
    const commit = (await ghApi(`repos/${REPO}/commits/${sha}`)) as {
      author: { login: string } | null;
      committer: { login: string } | null;
    } | null;
    return { author: commit?.author?.login ?? null, committer: commit?.committer?.login ?? null };
  },
};

try {
  const env = process.env;
  const base = env[ESCAPE_ENV] === "1" ? { sha: "", label: "the last release" } : await releaseBase();
  const commits: LocalCommit[] = base.sha
    ? (await git("log", "--format=%H%x09%s", `${base.sha}..HEAD`))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ...title] = line.split("\t");
          return { sha, title: title.join("\t") };
        })
    : [];
  const reviewedPath = path.join(repoRoot, REVIEWED_FILE);
  const reviewed = fs.existsSync(reviewedPath) ? parseReviewed(fs.readFileSync(reviewedPath, "utf8")) : [];

  const report = await checkReleaseAuthors({ commits, reviewed, github, baseLabel: base.label, env });
  if (report.status === "pass" || report.status === "skipped") {
    (report.status === "skipped" ? console.warn : console.log)(report.message);
    process.exit(0);
  }
  console.error(report.message);
  process.exit(1);
} catch (error) {
  console.error(`Release blocked: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`If Mathias or Frozaken checked every commit since the last release by hand: ${ESCAPE_ENV}=1 npm publish`);
  process.exit(1);
}
