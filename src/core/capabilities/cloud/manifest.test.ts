import { describe, expect, it } from "vitest";
import { parseManifest, serializeManifest, sha256Hex } from "./manifest.js";
import type { CloudManifest } from "./types.js";

const projectId = "11111111-1111-4111-8111-111111111111";

function manifest(files: CloudManifest["files"]): CloudManifest {
  return { schemaVersion: 1, projectId, rulesVersion: 1, files };
}

const file = (n: number) => ({ sha256: String(n).repeat(64).slice(0, 64), size: n });

describe("manifest serialization (spec 6.3)", () => {
  it("round-trips through gzip", () => {
    const m = manifest({ "a.gd": file(1), "b/c.png": file(2) });
    expect(parseManifest(serializeManifest(m), projectId)).toEqual(m);
  });

  it("produces identical bytes regardless of key insertion order (dedup across versions)", () => {
    const a = serializeManifest(manifest({ "a.gd": file(1), "z.gd": file(2), "m.gd": file(3) }));
    const b = serializeManifest(manifest({ "z.gd": file(2), "m.gd": file(3), "a.gd": file(1) }));
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });

  it("sorts keys bytewise, not locale-aware", () => {
    // Bytewise UTF-8: "Z" (0x5a) sorts before "a" (0x61), and "é" after both.
    const bytes = serializeManifest(manifest({ "a.gd": file(1), "Z.gd": file(2), "é.gd": file(3) }));
    const parsed = parseManifest(bytes, projectId);
    expect(Object.keys(parsed.files)).toEqual(["Z.gd", "a.gd", "é.gd"]);
  });

  it("rejects manifests with invalid paths", () => {
    const bad = manifest({ "../escape.gd": file(1) });
    expect(() => parseManifest(serializeManifest(bad), projectId)).toThrow(/Invalid manifest path/);
  });

  it("rejects casefold collisions", () => {
    const bad = manifest({ "Foo.gd": file(1), "foo.gd": file(2) });
    expect(() => parseManifest(serializeManifest(bad), projectId)).toThrow(/collision/);
  });

  it("rejects directory-prefix collisions", () => {
    const bad = manifest({ assets: file(1), "assets/a.png": file(2) });
    expect(() => parseManifest(serializeManifest(bad), projectId)).toThrow(/collision/);
  });

  it("rejects projectId mismatches", () => {
    const bytes = serializeManifest(manifest({ "a.gd": file(1) }));
    expect(() => parseManifest(bytes, "22222222-2222-4222-8222-222222222222")).toThrow(/mismatch/);
  });
});
