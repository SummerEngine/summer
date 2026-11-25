import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ESCAPE_ENV,
  REVIEWED_FILE,
  checkReleaseAuthors,
  parseReviewed,
  type CommitLogins,
  type GitHubLookup,
  type LocalCommit,
  type PullRef,
} from "./check.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha = (c: string) => c.repeat(40);
const commit = (c: string, title = `commit ${c}`): LocalCommit => ({ sha: sha(c), title });

/** Fake GitHub: per-SHA PR lists and commit logins; missing PR list = direct push. */
function fakeGitHub(pulls: Record<string, PullRef[] | null>, logins: Record<string, CommitLogins> = {}): GitHubLookup {
  return {
    async pullsForCommit(s) {
      return s in pulls ? pulls[s] : [];
    },
    async commitLogins(s) {
      return logins[s] ?? { author: null, committer: null };
    },
  };
}

const run = (commits: LocalCommit[], github: GitHubLookup, reviewed = [] as { sha: string; note: string }[], env = {}) =>
  checkReleaseAuthors({ commits, reviewed, github, baseLabel: "summer-engine@3.8.0 (0a4b6d98d)", env });

describe("checkReleaseAuthors", () => {
  it("passes PRs by mathias-heide and frozaken", async () => {
    const report = await run(
      [commit("a"), commit("b")],
      fakeGitHub({
        [sha("a")]: [{ number: 127, login: "mathias-heide", merged: true }],
        [sha("b")]: [{ number: 104, login: "Frozaken", merged: true }],
      }),
    );
    expect(report.status).toBe("pass");
    expect(report.verdicts.map((v) => v.status)).toEqual(["allowed", "allowed"]);
  });

  it("blocks a PR by an outside account and lists it", async () => {
    const report = await run(
      [commit("c", "fix(config): recognise the IPv6 loopback (#41)")],
      fakeGitHub({ [sha("c")]: [{ number: 41, login: "Abhishek-B-R", merged: true }] }),
    );
    expect(report.status).toBe("outside");
    expect(report.message).toContain("cccccccc");
    expect(report.message).toContain("PR #41");
    expect(report.message).toContain("Abhishek-B-R");
    expect(report.message).toContain("fix(config): recognise the IPv6 loopback (#41)");
    expect(report.message).toContain(REVIEWED_FILE);
  });

  it("passes an outside commit accepted in the reviewed list", async () => {
    const report = await run(
      [commit("c")],
      fakeGitHub({ [sha("c")]: [{ number: 41, login: "Abhishek-B-R", merged: true }] }),
      [{ sha: sha("c"), note: "Accepted by mathias-heide on 2026-10-14" }],
    );
    expect(report.status).toBe("pass");
    expect(report.verdicts[0].status).toBe("reviewed");
  });

  it("blocks an outsider's PR even when its commit email fakes Mathias", async () => {
    // The commit's author email maps to mathias-heide, but the PR is the outsider's.
    const report = await run(
      [commit("d")],
      fakeGitHub(
        { [sha("d")]: [{ number: 200, login: "someone-else", merged: true }] },
        { [sha("d")]: { author: "mathias-heide", committer: "mathias-heide" } },
      ),
    );
    expect(report.status).toBe("outside");
    expect(report.verdicts[0]).toMatchObject({ pr: 200, login: "someone-else" });
  });

  it("passes a direct push by frozaken", async () => {
    const report = await run(
      [commit("e")],
      fakeGitHub({}, { [sha("e")]: { author: "frozaken", committer: "frozaken" } }),
    );
    expect(report.status).toBe("pass");
    expect(report.verdicts[0]).toMatchObject({ status: "allowed", reason: "direct push" });
  });

  it("passes Claude only when pushed under an owner account", async () => {
    const underMathias = await run(
      [commit("f")],
      fakeGitHub({}, { [sha("f")]: { author: "claude[bot]", committer: "mathias-heide" } }),
    );
    expect(underMathias.status).toBe("pass");

    const onItsOwn = await run(
      [commit("f")],
      fakeGitHub({ [sha("f")]: [{ number: 300, login: "claude[bot]", merged: true }] }),
    );
    expect(onItsOwn.status).toBe("outside");
  });

  it("blocks a direct push by another writer and a commit GitHub does not have", async () => {
    const report = await run(
      [commit("1"), commit("2")],
      fakeGitHub({ [sha("2")]: null }, { [sha("1")]: { author: "beppep", committer: "beppep" } }),
    );
    expect(report.status).toBe("outside");
    expect(report.verdicts.map((v) => v.status)).toEqual(["outside", "outside"]);
    expect(report.message).toContain("GitHub does not have this commit");
  });

  it("fails closed when GitHub cannot be asked, naming the escape variable", async () => {
    const down: GitHubLookup = {
      async pullsForCommit() {
        throw new Error("gh api: To get started with GitHub CLI, please run:  gh auth login");
      },
      async commitLogins() {
        throw new Error("unreachable");
      },
    };
    const report = await run([commit("a")], down);
    expect(report.status).toBe("unavailable");
    expect(report.message).toContain("gh auth login");
    expect(report.message).toContain(`${ESCAPE_ENV}=1 npm publish`);

    const skipped = await run([commit("a")], down, [], { [ESCAPE_ENV]: "1" });
    expect(skipped.status).toBe("skipped");
  });
});

describe("parseReviewed", () => {
  it("reads the committed list", () => {
    const entries = parseReviewed(fs.readFileSync(path.join(repoRoot, REVIEWED_FILE), "utf8"));
    expect(entries.map((e) => e.sha)).toContain("ffeacda9d1988fa6caddfedc15574948899c09c8");
  });

  it("rejects short SHAs and missing notes", () => {
    expect(() => parseReviewed(JSON.stringify({ reviewed: [{ sha: "ffeacda9d", note: "x" }] }))).toThrow(/40-character/);
    expect(() => parseReviewed(JSON.stringify({ reviewed: [{ sha: sha("a") }] }))).toThrow(/note/);
  });
});
