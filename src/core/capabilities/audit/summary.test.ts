import { describe, expect, it } from "vitest";
import type { AuditIssue } from "./judge.js";
import { buildPage, bytes, countIssues, filterIssues, partialChecks, SUMMARY_CAP_BYTES, sortIssues, timingPerCheck } from "./summary.js";

function issue(over: Partial<AuditIssue> = {}): AuditIssue {
  return {
    check: "floating",
    severity: "warn",
    path: "Props/Crate",
    pos: [1, 0, 2],
    why: "floats 4 cm above Ground/Tile",
    ev: { gap_m: 0.04 },
    next: "summer_snap_to_surface Props/Crate",
    score: 0.04,
    ...over,
  };
}

describe("ordering and filters", () => {
  it("sorts by severity, then the check's place in the list, then magnitude", () => {
    const sorted = sortIssues([
      issue({ severity: "look", check: "orientation", path: "a" }),
      issue({ severity: "warn", check: "floating", score: 0.03, path: "b" }),
      issue({ severity: "error", check: "insert_host", path: "c" }),
      issue({ severity: "warn", check: "floating", score: 0.09, path: "d" }),
      issue({ severity: "error", check: "through_hole", path: "e" }),
    ]);
    expect(sorted.map((i) => i.path)).toEqual(["e", "c", "d", "b", "a"]);
  });

  it("min_severity keeps that severity and everything above it", () => {
    const all = [issue({ severity: "error" }), issue({ severity: "warn" }), issue({ severity: "look" })];
    expect(filterIssues(all, "error")).toHaveLength(1);
    expect(filterIssues(all, "warn")).toHaveLength(2);
    expect(filterIssues(all)).toHaveLength(3);
  });

  it("counts per check without zeros, and lists the clean checks that ran", () => {
    const { counts, clean } = countIssues([issue(), issue({ severity: "error" }), issue({ check: "through_hole", severity: "error" })], ["through_hole", "floating", "lights"]);
    expect(counts).toEqual({ through_hole: { error: 1 }, floating: { error: 1, warn: 1 } });
    expect(Object.keys(counts)).toEqual(["through_hole", "floating"]);
    expect(clean).toEqual(["lights"]);
  });
});

describe("budget: checks stopped early are partial in the counts", () => {
  it("a partial check carries the share it covered and is never 'clean', even with nothing found", () => {
    const { counts, clean } = countIssues([issue({ check: "through_hole", severity: "error" })], ["through_hole", "floor_gap", "lights"], { through_hole: 0.62, floor_gap: 0.4 });
    expect(counts).toEqual({ through_hole: { error: 1, partial: 0.62 }, floor_gap: { partial: 0.4 } });
    expect(clean).toEqual(["lights"]);
  });

  it("kernel stages map to the checks they measure for; the lowest share wins; never rounded up to whole", () => {
    const ran = ["through_hole", "floor_gap", "z_fight", "floating", "sunken", "orientation"] as const;
    const p = partialChecks({ through_hole: [620, 1000], floor_gap: [1, 2], floating_sunken: [9999, 10000], mount_gap: [0, 40], poses: [10, 20], resource: [5, 5] }, [...ran]);
    expect(p.checks).toEqual({ through_hole: 0.62, floor_gap: 0.5, z_fight: 0.5, floating: 0.99, sunken: 0.99, orientation: 0 });
    expect(p.other).toEqual({ poses: 0.5 });
    // A stage for a check that was not asked for adds nothing.
    expect(partialChecks({ through_hole: [1, 2] }, ["floor_gap"]).checks).toEqual({});
    expect(partialChecks(undefined, ["floor_gap"])).toEqual({ checks: {}, other: {} });
    expect(partialChecks({ x: "bad", through_hole: [5, 0] }, ["through_hole"]).checks).toEqual({});
  });
});

describe("paging under the 5 KB cap", () => {
  const base = { ok: true, tool: "summer_scene_audit", counts: { floating: { warn: 200 } }, notes: ["read-only"] };
  const many = Array.from({ length: 200 }, (_, i) => issue({ path: `Props/Crate_${i}`, why: `floats ${i} cm above Ground/Tile_${i} `.repeat(3), score: 1 / (i + 1) }));

  it("never exceeds the cap, names the next offset and says the cap ended the page", () => {
    const page = buildPage({ base, issues: many, offset: 0, limit: 50 });
    expect(bytes(page.body)).toBeLessThanOrEqual(SUMMARY_CAP_BYTES);
    expect(page.shown.length).toBeGreaterThan(3);
    expect(page.shown.length).toBeLessThan(50);
    expect(page.body.next_offset).toBe(page.shown.length);
    expect(page.body.trimmed_to_fit).toBe(true);
    expect(page.shown[0]!.n).toBe(1);
  });

  it("holds the cap for every page size and prose length (the trimmed flag included)", () => {
    for (let len = 0; len < 400; len += 7) {
      const list = Array.from({ length: 40 }, (_, i) => issue({ path: `P/${i}`, why: "w".repeat(len + (i % 13)) }));
      for (const limit of [1, 7, 15, 50]) {
        const page = buildPage({ base, issues: list, offset: 3, limit });
        expect(bytes(page.body), `len ${len} limit ${limit}`).toBeLessThanOrEqual(SUMMARY_CAP_BYTES);
      }
    }
  });

  it("offset continues the numbering; the last page has no next offset", () => {
    const second = buildPage({ base, issues: many, offset: 10, limit: 5 });
    expect(second.shown.map((s) => s.n)).toEqual([11, 12, 13, 14, 15]);
    expect(second.body.next_offset).toBe(15);
    const last = buildPage({ base, issues: many.slice(0, 12), offset: 10, limit: 5 });
    expect(last.shown).toHaveLength(2);
    expect(last.body.next_offset).toBeNull();
    const beyond = buildPage({ base, issues: many.slice(0, 3), offset: 99, limit: 5 });
    expect(beyond.shown).toHaveLength(0);
    expect(beyond.body.offset).toBe(3);
  });

  it("limit ends a page before the cap does", () => {
    const page = buildPage({ base, issues: many, offset: 0, limit: 2 });
    expect(page.shown).toHaveLength(2);
    expect(page.body.trimmed_to_fit).toBeUndefined();
  });

  it("a single issue larger than the cap is cut down rather than dropped", () => {
    const huge = issue({ why: "x".repeat(9000), ev: { blob: "y".repeat(9000), a: 1, b: 2, c: 3, d: 4, e: 5 }, next: "z".repeat(3000) });
    const page = buildPage({ base, issues: [huge, issue()], offset: 0, limit: 10 });
    expect(bytes(page.body)).toBeLessThanOrEqual(SUMMARY_CAP_BYTES);
    expect(page.shown).toHaveLength(2);
    expect(page.shown[0]!.why.length).toBeLessThanOrEqual(200);
  });

  it("an issue never carries the internal frame hint or score", () => {
    const page = buildPage({ base, issues: [issue({ frame: { focus: [0, 0, 0], size: 1, dirs: [] } })], offset: 0, limit: 5 });
    expect(Object.keys(page.shown[0]!).sort()).toEqual(["check", "ev", "key", "n", "next", "path", "pos", "sev", "why"]);
  });
});

describe("timing per check", () => {
  it("folds setup stages and maps kernel stages to check names", () => {
    const t = timingPerCheck({ collect: 5, manifests_roles: 2, mesh_pass: 100, physics_build: 150, through_hole: 190, floating_sunken: 3, total: 800 }, { roundtrip: 1100 });
    expect(t).toMatchObject({ setup: 257, through_hole: 190, "floating+sunken": 3, editor_total: 800, roundtrip: 1100 });
  });
});
