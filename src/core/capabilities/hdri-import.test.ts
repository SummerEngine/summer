import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HDRI_MAX_DOWNLOAD_BYTES,
  hdriApplySnippet,
  importHdriArgsSchema,
  importPolyHavenHdri,
  isPolyHavenDownloadUrl,
  isSafePolyHavenId,
} from "./hdri-import.js";

const HDR_URL = "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/kloppenheim_02_2k.hdr";

function filesResponse(size: number) {
  return { hdri: { "2k": { hdr: { url: HDR_URL, size } } } };
}

function stubFiles(size: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/files/")) return Response.json(filesResponse(size));
      throw new Error(`unexpected fetch ${url}`);
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("isPolyHavenDownloadUrl", () => {
  it("accepts https Poly Haven hosts", () => {
    expect(isPolyHavenDownloadUrl(HDR_URL)).toBe(true);
    expect(isPolyHavenDownloadUrl("https://polyhaven.com/a.hdr")).toBe(true);
    expect(isPolyHavenDownloadUrl("https://cdn.polyhaven.com/a.exr")).toBe(true);
  });

  it("rejects http, embedded credentials, look-alike hosts, and garbage", () => {
    expect(isPolyHavenDownloadUrl("http://dl.polyhaven.org/a.hdr")).toBe(false);
    expect(isPolyHavenDownloadUrl("https://user:pw@polyhaven.com/a.hdr")).toBe(false);
    expect(isPolyHavenDownloadUrl("https://user@polyhaven.com/a.hdr")).toBe(false);
    expect(isPolyHavenDownloadUrl("https://evil.com/polyhaven.com/a.hdr")).toBe(false);
    expect(isPolyHavenDownloadUrl("https://polyhaven.com.evil.com/a.hdr")).toBe(false);
    expect(isPolyHavenDownloadUrl("https://notpolyhaven.com/a.hdr")).toBe(false);
    expect(isPolyHavenDownloadUrl("not a url")).toBe(false);
  });
});

describe("isSafePolyHavenId", () => {
  it("accepts slugs and rejects path or query characters", () => {
    expect(isSafePolyHavenId("kloppenheim_02")).toBe(true);
    expect(isSafePolyHavenId("night-city")).toBe(true);
    expect(isSafePolyHavenId("../etc")).toBe(false);
    expect(isSafePolyHavenId("Sky One")).toBe(false);
    expect(isSafePolyHavenId("")).toBe(false);
  });
});

describe("importHdriArgsSchema", () => {
  it("defaults resolution to 2k and rejects off-ladder values", () => {
    expect(importHdriArgsSchema.parse({ query: "sunset" })).toMatchObject({
      resolution: "2k",
      allow_large: false,
    });
    expect(importHdriArgsSchema.safeParse({ query: "sunset", resolution: "8k" }).success).toBe(false);
  });
});

describe("hdriApplySnippet", () => {
  it("is plain GDScript against WorldEnvironment using only baseline ctx helpers", () => {
    const script = hdriApplySnippet("res://sky/kloppenheim_02_2k.hdr");
    expect(script).not.toContain("ensure_environment");
    expect(script).toContain("WorldEnvironment");
    expect(script).toContain("ctx.get_scene_root()");
    expect(script).toContain("ctx.set_owner_recursive(env)");
    expect(script).toContain('load("res://sky/kloppenheim_02_2k.hdr")');
  });
});

describe("importPolyHavenHdri size ceiling", () => {
  it("refuses a file above the ceiling before any engine call, unless allow_large", async () => {
    stubFiles(HDRI_MAX_DOWNLOAD_BYTES + 1);
    const executeOps = vi.fn(async () => ({ ok: true, results: [{ ok: true }] }));
    const engine = async () => ({ executeOps });

    await expect(
      importPolyHavenHdri({ assetId: "kloppenheim_02", resolution: "2k" }, engine)
    ).rejects.toMatchObject({ code: "file_too_large" });
    expect(executeOps).not.toHaveBeenCalled();

    const result = await importPolyHavenHdri(
      { assetId: "kloppenheim_02", resolution: "2k", allow_large: true },
      engine
    );
    expect(result.importedTo).toBe("res://sky/kloppenheim_02_2k.hdr");
    expect(executeOps).toHaveBeenCalledTimes(1);
  });

  it("imports files under the ceiling without opting in", async () => {
    stubFiles(12 * 1024 * 1024);
    const executeOps = vi.fn(async () => ({ ok: true, results: [{ ok: true }] }));
    const result = await importPolyHavenHdri(
      { assetId: "kloppenheim_02", resolution: "2k" },
      async () => ({ executeOps })
    );
    expect(result.success).toBe(true);
    expect(executeOps).toHaveBeenCalledWith([
      { op: "ImportFromUrl", url: HDR_URL, path: "res://sky/kloppenheim_02_2k.hdr" },
    ]);
  });
});
