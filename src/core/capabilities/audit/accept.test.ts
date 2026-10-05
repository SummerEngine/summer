import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACCEPT_FILE, AcceptStoreError, applyAccepts, issueKey, mergeAccepts, parseAcceptFile, staleReason, validIssueKey, writeAcceptFile, type AcceptEntry } from "./accept.js";
import type { AuditIssue } from "./judge.js";

const issue = (over: Partial<AuditIssue> = {}): AuditIssue => ({
  check: "z_fight",
  severity: "look",
  path: "House1/Corners/FR_c1",
  pos: [8.97, 2.94, 0.06],
  why: "coplanar overlapping faces with House1/F_c1_2: 0.02 m2 on the same plane",
  ev: {},
  next: "x",
  score: 0.02,
  ...over,
});

const SCENE = "res://three_houses_v3.tscn";

describe("issue keys", () => {
  it("check:path@x,y,z with the position rounded to 0.1 m", () => {
    expect(issueKey(issue())).toBe("z_fight:House1/Corners/FR_c1@9,2.9,0.1");
    expect(issueKey(issue({ pos: [-0.04, 12.25, -6] }))).toBe("z_fight:House1/Corners/FR_c1@0,12.3,-6");
    expect(validIssueKey(issueKey(issue()))).toBe(true);
    expect(validIssueKey("z_fight:a:b@1,2,3")).toBe(false);
    expect(validIssueKey('z_fight:a"b@1,2,3')).toBe(false);
    expect(validIssueKey("z_fight:House1/Corners/FR_c1@9,2.9")).toBe(false);
  });
});

describe("accepting look items", () => {
  it("adds entries for this run's issues and refuses errors and unknown keys", () => {
    const issues = [issue(), issue({ check: "through_hole", severity: "error", path: "House3/Back/F", pos: [1, 2, 3] })];
    const out = mergeAccepts([], [
      { key: issueKey(issues[0]!), reason: "inside-corner band overlap, hidden" },
      { key: issueKey(issues[1]!), reason: "fine" },
      { key: "z_fight:Nope@1,2,3", reason: "gone" },
    ], issues, SCENE, new Date("2026-10-04T12:00:00Z"));
    expect(out.added).toEqual([issueKey(issues[0]!)]);
    expect(out.refused.map((r) => r.why)).toEqual(["errors cannot be accepted: fix it", expect.stringMatching(/no issue with this key/)]);
    expect(out.entries).toEqual([{ key: issueKey(issues[0]!), scene: SCENE, reason: "inside-corner band overlap, hidden", check: "z_fight", severity: "look", score: 0.02, why: issues[0]!.why, at: "2026-10-04T12:00:00.000Z" }]);
  });

  it("re-accepting a key replaces its entry; other scenes' entries are kept", () => {
    const other: AcceptEntry = { key: issueKey(issue()), scene: "res://other.tscn", reason: "x", check: "z_fight", severity: "look", score: 1, why: "", at: "" };
    const first = mergeAccepts([other], [{ key: issueKey(issue()), reason: "first" }], [issue()], SCENE).entries!;
    const second = mergeAccepts(first, [{ key: issueKey(issue()), reason: "second" }], [issue({ score: 0.021 })], SCENE).entries!;
    expect(second.map((e) => [e.scene, e.reason])).toEqual([
      ["res://other.tscn", "x"],
      [SCENE, "second"],
    ]);
  });

  it("accepted items are hidden and counted; they show again when the evidence changes materially", () => {
    const entries = mergeAccepts([], [{ key: issueKey(issue()), reason: "hidden contact face" }], [issue()], SCENE).entries!;
    const same = applyAccepts([issue({ score: 0.0204 })], entries, SCENE);
    expect(same.shown).toEqual([]);
    expect(same.accepted.map((a) => a.entry.reason)).toEqual(["hidden contact face"]);
    // Bigger by over 25%: shown again, marked stale.
    const grown = applyAccepts([issue({ score: 0.3 })], entries, SCENE);
    expect(grown.shown).toHaveLength(1);
    expect(grown.stale[0]!.why).toMatch(/evidence changed: magnitude 0.02 -> 0.3/);
    // A higher severity: shown again.
    expect(staleReason(entries[0]!, issue({ severity: "warn" }))).toBe("severity rose from look to warn");
    // Another scene's accepts do not apply.
    expect(applyAccepts([issue()], entries, "res://other.tscn").shown).toHaveLength(1);
    // An error is never hidden, whatever the file says.
    expect(applyAccepts([issue({ severity: "error" })], [{ ...entries[0]!, severity: "warn" }], SCENE).shown).toHaveLength(1);
  });

  it("parses the file the kernel echoes and drops malformed entries", () => {
    const good = { key: issueKey(issue()), scene: SCENE, reason: "ok", check: "z_fight", severity: "look", score: 0.02, why: "w", at: "t" };
    expect(parseAcceptFile({ version: 1, entries: [good, { key: "bad" }, { ...good, severity: "error" }, null] })).toEqual([good]);
    expect(parseAcceptFile(null)).toEqual([]);
  });
});

describe("the accept file", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "audit-accept-"));
    writeFileSync(join(project, "project.godot"), "config_version=5\n");
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("is written to res://.summer/audit-accept.json and read back", async () => {
    const entries = mergeAccepts([], [{ key: issueKey(issue()), reason: "fine" }], [issue()], SCENE).entries!;
    const file = await writeAcceptFile(project, entries);
    expect(file).toBe(join(project, ACCEPT_FILE));
    expect(parseAcceptFile(JSON.parse(readFileSync(file, "utf-8")))).toEqual(entries);
  });

  it("refuses a folder that is not a project, and symlinks", async () => {
    await expect(writeAcceptFile(undefined, [])).rejects.toBeInstanceOf(AcceptStoreError);
    await expect(writeAcceptFile(join(project, "nope"), [])).rejects.toThrow(/project folder is not known/);
    mkdirSync(join(project, ".summer"));
    const elsewhere = join(project, "elsewhere.json");
    writeFileSync(elsewhere, "{}");
    symlinkSync(elsewhere, join(project, ACCEPT_FILE));
    await expect(writeAcceptFile(project, [])).rejects.toThrow(/symlink/);
    expect(readFileSync(elsewhere, "utf-8")).toBe("{}");
    expect(existsSync(join(project, ".summer", "audit-accept.json"))).toBe(true);
  });
});
