import { describe, expect, it } from "vitest";
import { assertDeleteGuard, assertNotEmptyLocalTree, diffManifests, type DecisionKind } from "./diff.js";
import type { CloudManifest, ManifestFile } from "./types.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const h0 = { sha256: "0".repeat(64), size: 1 };
const h1 = { sha256: "1".repeat(64), size: 1 };
const h2 = { sha256: "2".repeat(64), size: 1 };

function manifest(files: CloudManifest["files"]): CloudManifest {
  return { schemaVersion: 1, projectId, rulesVersion: 1, files };
}

function decisionFor(
  base: ManifestFile | undefined,
  local: ManifestFile | undefined,
  remote: ManifestFile | undefined
): DecisionKind {
  const plan = diffManifests(
    manifest(base ? { "f.gd": base } : {}),
    manifest(local ? { "f.gd": local } : {}),
    manifest(remote ? { "f.gd": remote } : {})
  );
  return plan.decisions.find((d) => d.path === "f.gd")?.kind ?? "converged";
}

describe("decision table, all 15 rows (spec 8.4)", () => {
  it("row 1: absent everywhere is nothing", () => {
    const plan = diffManifests(manifest({}), manifest({}), manifest({}));
    expect(plan.decisions).toEqual([]);
  });

  it("row 2: local add pushes", () => {
    expect(decisionFor(undefined, h1, undefined)).toBe("push");
  });

  it("row 3: remote add pulls", () => {
    expect(decisionFor(undefined, undefined, h1)).toBe("pull");
  });

  it("row 4: both added identical converges", () => {
    expect(decisionFor(undefined, h1, h1)).toBe("converged");
  });

  it("row 5: both added different is a remote-wins conflict", () => {
    expect(decisionFor(undefined, h1, h2)).toBe("conflict-remote-wins");
  });

  it("row 6: unchanged everywhere is nothing", () => {
    expect(decisionFor(h0, h0, h0)).toBe("converged");
  });

  it("row 7: local modify pushes", () => {
    expect(decisionFor(h0, h1, h0)).toBe("push");
  });

  it("row 8: remote modify pulls", () => {
    expect(decisionFor(h0, h0, h1)).toBe("pull");
  });

  it("row 9: both modified identical converges", () => {
    expect(decisionFor(h0, h1, h1)).toBe("converged");
  });

  it("row 10: both modified different is a remote-wins conflict", () => {
    expect(decisionFor(h0, h1, h2)).toBe("conflict-remote-wins");
  });

  it("row 11: local delete pushes the delete", () => {
    expect(decisionFor(h0, undefined, h0)).toBe("delete-remote");
  });

  it("row 12: remote delete deletes locally", () => {
    expect(decisionFor(h0, h0, undefined)).toBe("delete-local");
  });

  it("row 13: deleted on both sides converges", () => {
    expect(decisionFor(h0, undefined, undefined)).toBe("converged");
  });

  it("row 14: local edit beats remote delete (keep-local, surfaced)", () => {
    expect(decisionFor(h0, h1, undefined)).toBe("keep-local");
    const plan = diffManifests(manifest({ "f.gd": h0 }), manifest({ "f.gd": h1 }), manifest({}));
    expect(plan.keepLocalPaths).toEqual(["f.gd"]);
  });

  it("row 15: remote edit beats local delete (restore, surfaced)", () => {
    expect(decisionFor(h0, undefined, h1)).toBe("pull");
    const plan = diffManifests(manifest({ "f.gd": h0 }), manifest({}), manifest({ "f.gd": h1 }));
    expect(plan.restoredRemotePaths).toEqual(["f.gd"]);
  });

  it("override: L == R converges regardless of base", () => {
    expect(decisionFor(h0, h2, h2)).toBe("converged");
    expect(decisionFor(undefined, h2, h2)).toBe("converged");
  });

  it("zero-byte files are valid content, not deletions", () => {
    const empty = { sha256: "e".repeat(64), size: 0 };
    expect(decisionFor(undefined, empty, undefined)).toBe("push");
  });
});

describe("sidecar pairing (spec 8.4)", () => {
  it("conflicted primary drags a locally pushed .import to the remote side", () => {
    const plan = diffManifests(
      manifest({ "foo.png": h0, "foo.png.import": h0 }),
      manifest({ "foo.png": h1, "foo.png.import": h1 }),
      manifest({ "foo.png": h2, "foo.png.import": h0 })
    );
    expect(plan.conflictPaths).toContain("foo.png");
    // The sidecar would have been a push; the primary's remote-wins direction
    // forces it back to the remote side (locally modified, so it conflicts
    // and its bytes land inside the conflict set folder).
    expect(plan.pushPaths).not.toContain("foo.png.import");
    expect(plan.conflictPaths).toContain("foo.png.import");
  });

  it("primary delete-local drags the sidecar delete", () => {
    const plan = diffManifests(
      manifest({ "foo.gd": h0, "foo.gd.uid": h0 }),
      manifest({ "foo.gd": h0, "foo.gd.uid": h1 }),
      manifest({})
    );
    expect(plan.deleteLocalPaths).toContain("foo.gd");
    expect(plan.deleteLocalPaths).toContain("foo.gd.uid");
  });

  it("primary push drags a remotely deleted sidecar back as push", () => {
    const plan = diffManifests(
      manifest({ "foo.png": h0, "foo.png.import": h0 }),
      manifest({ "foo.png": h1, "foo.png.import": h0 }),
      manifest({ "foo.png": h0 })
    );
    expect(plan.pushPaths).toContain("foo.png");
    expect(plan.pushPaths).toContain("foo.png.import");
    expect(plan.deleteLocalPaths).not.toContain("foo.png.import");
  });

  it("sidecar may act alone when the primary is converged", () => {
    const plan = diffManifests(
      manifest({ "foo.png": h0, "foo.png.import": h0 }),
      manifest({ "foo.png": h0, "foo.png.import": h1 }),
      manifest({ "foo.png": h0, "foo.png.import": h0 })
    );
    expect(plan.pushPaths).toEqual(["foo.png.import"]);
  });
});

describe("mass-deletion guardrails (spec 8.5)", () => {
  function planWithDeletes(count: number, baseCount: number) {
    const baseFiles: CloudManifest["files"] = {};
    const localFiles: CloudManifest["files"] = {};
    for (let i = 0; i < baseCount; i += 1) {
      const path = `f${String(i).padStart(3, "0")}.gd`;
      baseFiles[path] = h0;
      if (i >= count) localFiles[path] = h0;
    }
    return diffManifests(manifest(baseFiles), manifest(localFiles), manifest(baseFiles));
  }

  it("allows small deletions without confirmation", () => {
    expect(() => assertDeleteGuard(planWithDeletes(2, 100), 100)).not.toThrow();
  });

  it("blocks more than 10 deletions", () => {
    expect(() => assertDeleteGuard(planWithDeletes(11, 100), 100)).toThrow(/confirm-deletes/);
  });

  it("blocks 20 percent of the base", () => {
    expect(() => assertDeleteGuard(planWithDeletes(10, 50), 50)).toThrow(/confirm-deletes/);
  });

  it("blocks deletes == base even for tiny projects", () => {
    expect(() => assertDeleteGuard(planWithDeletes(2, 2), 2)).toThrow(/confirm-deletes/);
  });

  it("confirmation flag allows the guarded push", () => {
    expect(() => assertDeleteGuard(planWithDeletes(11, 100), 100, true)).not.toThrow();
  });

  it("empty local tree with non-empty base aborts outright, no confirmation possible", () => {
    expect(() => assertNotEmptyLocalTree(5, 0)).toThrow(/unmounted volume|Aborting/);
    expect(() => assertNotEmptyLocalTree(0, 0)).not.toThrow();
    expect(() => assertNotEmptyLocalTree(5, 1)).not.toThrow();
  });
});

describe("legacy aggregate behavior", () => {
  it("implements add/modify/delete/converged decisions", () => {
    const plan = diffManifests(
      manifest({
        "pull.gd": h0,
        "push.gd": h0,
        "delete-local.gd": h0,
        "delete-remote.gd": h0,
      }),
      manifest({
        "push.gd": h1,
        "pull.gd": h0,
        "delete-local.gd": h0,
        "local-only.gd": h1,
      }),
      manifest({
        "push.gd": h0,
        "pull.gd": h1,
        "delete-remote.gd": h0,
        "remote-only.gd": h1,
      })
    );

    expect(plan.pushPaths.sort()).toEqual(["local-only.gd", "push.gd"]);
    expect(plan.pullPaths.sort()).toEqual(["pull.gd", "remote-only.gd"]);
    expect(plan.deleteLocalPaths).toEqual(["delete-local.gd"]);
    expect(plan.deleteRemotePaths).toEqual(["delete-remote.gd"]);
  });
});
