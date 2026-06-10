import { describe, expect, it } from "vitest";
import { casefoldKey, findPathCollisions, validateCloudPath } from "./validate-path.js";

function reason(path: string): string | null {
  const result = validateCloudPath(path);
  return result.ok ? null : result.reason;
}

describe("validateCloudPath (spec 9)", () => {
  it("accepts normal keys", () => {
    expect(reason("scripts/player.gd")).toBeNull();
    expect(reason("assets/models/player.glb")).toBeNull();
    expect(reason(".summercloudignore")).toBeNull();
    expect(reason("icon.svg")).toBeNull();
  });

  it("rejects traversal and absolute forms", () => {
    expect(reason("../escape.gd")).toMatch(/dot/);
    expect(reason("a/../b.gd")).toMatch(/dot/);
    expect(reason("/abs.gd")).toMatch(/relative/);
    expect(reason("C:/windows.gd")).toMatch(/relative/);
    expect(reason("a\\b.gd")).toMatch(/relative|invalid/);
  });

  it("rejects NFD keys", () => {
    const nfd = "cafe\u0301.gd"; // e + combining acute (NFD)
    expect(reason(nfd)).toMatch(/NFC/);
    expect(reason(nfd.normalize("NFC"))).toBeNull();
  });

  it("rejects control bytes and reserved characters but allows spaces", () => {
    expect(reason("a\u0001b.gd")).toMatch(/invalid/);
    expect(reason("a\tb.gd")).toMatch(/invalid/);
    expect(reason("a b.gd")).toBeNull();
    expect(reason("a<b.gd")).toMatch(/reserved/);
    expect(reason("a:b.gd")).toMatch(/relative|reserved/);
    expect(reason("a?.gd")).toMatch(/reserved/);
  });

  it("rejects Windows device names including superscripts, case-insensitively", () => {
    expect(reason("CON")).toMatch(/device/);
    expect(reason("aux.gd")).toMatch(/device/);
    expect(reason("sub/NUL.txt")).toMatch(/device/);
    expect(reason("com1.gd")).toMatch(/device/);
    expect(reason("COM0.gd")).toMatch(/device/);
    expect(reason("lpt¹.gd")).toMatch(/device/);
    expect(reason("com³.txt")).toMatch(/device/);
    expect(reason("console.gd")).toBeNull(); // prefix only matters before the first dot
  });

  it("rejects trailing dot or space segments", () => {
    expect(reason("dir./file.gd")).toMatch(/dot or space/);
    expect(reason("file.gd ")).toMatch(/dot or space/);
    expect(reason("file.")).toMatch(/dot or space/);
  });

  it("caps the key at 1024 bytes and segments at 255 bytes", () => {
    const seg = "a".repeat(255);
    expect(reason(seg)).toBeNull();
    expect(reason("a".repeat(256))).toMatch(/255/);
    const long = Array(5).fill("b".repeat(250)).join("/"); // 1254 bytes
    expect(reason(long)).toMatch(/1024/);
    const ok = `${seg}/${"b".repeat(255)}/${"c".repeat(255)}/${"d".repeat(255)}`; // 1023 bytes
    expect(reason(ok)).toBeNull();
  });
});

describe("casefoldKey", () => {
  it("folds beyond plain toLowerCase", () => {
    expect(casefoldKey("Straße.gd")).toBe(casefoldKey("STRASSE.GD"));
    expect(casefoldKey("ſcript.gd")).toBe(casefoldKey("script.gd")); // long s
    expect(casefoldKey("Foo.GD")).toBe(casefoldKey("foo.gd"));
  });
});

describe("findPathCollisions", () => {
  it("flags casefold pairs", () => {
    const collisions = findPathCollisions(["Foo.gd", "foo.gd"]);
    expect(collisions.some((c) => c.kind === "casefold")).toBe(true);
  });

  it("flags directory-prefix collisions", () => {
    const collisions = findPathCollisions(["assets", "assets/player.png"]);
    expect(collisions.some((c) => c.kind === "prefix" && c.a === "assets")).toBe(true);
  });

  it("accepts disjoint trees", () => {
    expect(findPathCollisions(["assets/player.png", "assets2/player.png", "scripts/player.gd"])).toEqual([]);
  });
});
