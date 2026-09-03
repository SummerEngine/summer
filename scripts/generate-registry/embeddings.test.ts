import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeVector, type EmbedResponse } from "../../src/core/embeddings.ts";
import { applyManifests } from "./apply.ts";
import { checkRegistry } from "./check.ts";
import {
  EMBEDDINGS_BANNER,
  checkEmbeddings,
  embedRegistry,
  embeddingsPath,
  readEmbeddingsFile,
  resolveEmbedEndpoint,
} from "./embed.ts";
import { generateRegistry, writeGenerated, type LoadedResource } from "./index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const schemasDir = path.join(repoRoot, "registry", "schemas");
const basicRoot = path.join(here, "fixtures", "basic");

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function copyBasicFixture(): string {
  const dest = tmpDir("genreg-embed-");
  fs.cpSync(basicRoot, dest, { recursive: true });
  return dest;
}

function generateAndApply(root: string): LoadedResource[] {
  const result = generateRegistry(root, { schemasDir });
  writeGenerated(path.join(root, "registry", "generated"), result);
  applyManifests(root);
  return result.resources;
}

/** Deterministic 4-dim "embedding" derived from the text; reports a model. */
function fakeProvider(model = "fake-1", dims = 4) {
  return vi.fn(async (text: string): Promise<EmbedResponse> => {
    const vector = Array.from({ length: dims }, (_, i) => {
      let acc = 0;
      for (let c = 0; c < text.length; c++) acc += text.charCodeAt(c) * ((c % (i + 1)) + 1);
      return (acc % 1000) / 1000;
    });
    return { vector, model };
  });
}

function skillFile(root: string, slug: string, file: string): string {
  return path.join(root, "library", "skills", slug, file);
}

describe("embedRegistry: the optional embeddings sidecar", () => {
  it("writes one base64-float32 vector per resource, sorted by id, with the index content hashes", async () => {
    const root = copyBasicFixture();
    const resources = generateAndApply(root);
    const provider = fakeProvider();
    const summary = await embedRegistry(root, resources, provider, { concurrency: 2 });
    expect(summary).toMatchObject({ total: resources.length, computed: resources.length, reused: 0, pruned: 0, model: "fake-1", dims: 4 });
    expect(provider).toHaveBeenCalledTimes(resources.length);
    const { exists, file } = readEmbeddingsFile(root);
    expect(exists).toBe(true);
    expect(file!._generated).toBe(EMBEDDINGS_BANNER);
    expect(Object.keys(file!.entries)).toEqual(resources.map((r) => r.id).sort());
    for (const res of resources) {
      expect(file!.entries[res.id]!.content_hash).toBe(res.contentHash);
      expect(decodeVector(file!.entries[res.id]!.vector).length).toBe(4);
    }
    // The embedded text is summary + use_when + facets, never the body.
    const firstCall = provider.mock.calls[0]![0];
    expect(firstCall.length).toBeGreaterThan(10);
    expect(firstCall).not.toContain("# ");
  });

  it("re-running with unchanged content reuses every vector and never calls the provider", async () => {
    const root = copyBasicFixture();
    const resources = generateAndApply(root);
    await embedRegistry(root, resources, fakeProvider());
    const before = fs.readFileSync(embeddingsPath(root), "utf8");
    const provider = fakeProvider();
    const summary = await embedRegistry(root, resources, provider);
    expect(provider).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ computed: 0, reused: resources.length, pruned: 0 });
    expect(fs.readFileSync(embeddingsPath(root), "utf8")).toBe(before);
  });

  it("recomputes only the resource whose content_hash changed, keeps the others byte-for-byte, prunes removed ids", async () => {
    const root = copyBasicFixture();
    const first = generateAndApply(root);
    await embedRegistry(root, first, fakeProvider());
    const before = readEmbeddingsFile(root).file!;

    fs.appendFileSync(skillFile(root, "alpha-skill", "SKILL.md"), "\nOne more paragraph.\n");
    fs.rmSync(path.join(root, "library", "skills", "beta-skill"), { recursive: true });
    const second = generateAndApply(root);
    const provider = fakeProvider();
    const summary = await embedRegistry(root, second, provider);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ total: first.length - 1, computed: 1, reused: first.length - 2, pruned: 1 });
    const after = readEmbeddingsFile(root).file!;
    expect(after.entries["skill/beta-skill"]).toBeUndefined();
    expect(after.entries["skill/alpha-skill"]!.content_hash).not.toBe(before.entries["skill/alpha-skill"]!.content_hash);
    for (const id of Object.keys(after.entries)) {
      if (id === "skill/alpha-skill") continue;
      expect(after.entries[id]).toEqual(before.entries[id]);
    }
  });

  it("a provider reporting a different model invalidates the whole cache", async () => {
    const root = copyBasicFixture();
    const resources = generateAndApply(root);
    await embedRegistry(root, resources, fakeProvider("fake-1"));
    fs.appendFileSync(skillFile(root, "alpha-skill", "SKILL.md"), "\nchanged\n");
    const changed = generateAndApply(root);
    const log = vi.fn();
    const summary = await embedRegistry(root, changed, fakeProvider("fake-2"), { log });
    expect(summary).toMatchObject({ computed: changed.length, reused: 0, model: "fake-2" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("fake-1 -> fake-2"));
  });

  it("refuses to mix vectors of different dims and names the fix", async () => {
    const root = copyBasicFixture();
    const resources = generateAndApply(root);
    await embedRegistry(root, resources, fakeProvider("fake-1", 4));
    fs.appendFileSync(skillFile(root, "alpha-skill", "SKILL.md"), "\nchanged\n");
    const changed = generateAndApply(root);
    await expect(embedRegistry(root, changed, fakeProvider("fake-1", 5))).rejects.toThrow(/dims.*delete registry\/generated\/embeddings\.json/);
  });
});

describe("checkEmbeddings + --check parity", () => {
  it("no sidecar -> nothing to say; a fresh sidecar -> no warnings; --check does not call it an extra file", async () => {
    const root = copyBasicFixture();
    const resources = generateAndApply(root);
    expect(checkEmbeddings(root, resources)).toEqual([]);
    await embedRegistry(root, resources, fakeProvider());
    expect(checkEmbeddings(root, resources)).toEqual([]);
    const check = checkRegistry(root, { schemasDir });
    expect(check.ok).toBe(true);
    expect(check.drift).toEqual([]);
    expect(check.warnings).toEqual([]);
  });

  it("content changed without re-embedding -> stale warning naming the id, still ok (exit 0)", async () => {
    const root = copyBasicFixture();
    const resources = generateAndApply(root);
    await embedRegistry(root, resources, fakeProvider());
    fs.appendFileSync(skillFile(root, "alpha-skill", "SKILL.md"), "\nchanged\n");
    generateAndApply(root);
    const check = checkRegistry(root, { schemasDir });
    expect(check.ok).toBe(true);
    expect(check.drift).toEqual([]);
    expect(check.warnings.some((w) => w.includes("stale") && w.includes("skill/alpha-skill"))).toBe(true);
    expect(check.warnings.at(-1)).toMatch(/warning, not drift/);
  });

  it("reports entries without a vector and vectors for ids that left the index", async () => {
    const root = copyBasicFixture();
    const resources = generateAndApply(root);
    await embedRegistry(root, resources, fakeProvider());
    const file = JSON.parse(fs.readFileSync(embeddingsPath(root), "utf8")) as { entries: Record<string, unknown> };
    file.entries["skill/ghost"] = file.entries["skill/alpha-skill"];
    delete file.entries["skill/beta-skill"];
    fs.writeFileSync(embeddingsPath(root), JSON.stringify(file));
    const warnings = checkEmbeddings(root, resources);
    expect(warnings.some((w) => w.includes("without a vector") && w.includes("skill/beta-skill"))).toBe(true);
    expect(warnings.some((w) => w.includes("no longer in the index") && w.includes("skill/ghost"))).toBe(true);
  });

  it("an unparsable sidecar is a warning, not drift", () => {
    const root = copyBasicFixture();
    const resources = generateAndApply(root);
    fs.writeFileSync(embeddingsPath(root), "{ not json");
    expect(checkEmbeddings(root, resources)).toEqual([expect.stringContaining("not a valid embeddings file")]);
    const check = checkRegistry(root, { schemasDir });
    expect(check.ok).toBe(true);
  });
});

describe("resolveEmbedEndpoint (mirrors the auth store and gateway config)", () => {
  it("SUMMER_EMBED_URL wins and works without a token", () => {
    const home = tmpDir("embed-home-");
    expect(resolveEmbedEndpoint({ SUMMER_EMBED_URL: "https://embed.example.test/v1" }, home)).toEqual({
      url: "https://embed.example.test/v1",
      token: null,
      source: "SUMMER_EMBED_URL",
    });
  });

  it("gateway endpoint needs a token: SUMMER_TOKEN, else ~/.summer/auth-token; gateway from env, config.json, or prod", () => {
    const home = tmpDir("embed-home-");
    expect(() => resolveEmbedEndpoint({}, home)).toThrow(/summer login/);
    expect(resolveEmbedEndpoint({ SUMMER_TOKEN: "env-tok", SUMMER_GATEWAY_URL: "https://staging.example.com/" }, home)).toEqual({
      url: "https://staging.example.com/api/mcp/embed",
      token: "env-tok",
      source: "gateway",
    });
    fs.mkdirSync(path.join(home, ".summer"));
    fs.writeFileSync(path.join(home, ".summer", "auth-token"), "file-tok\n");
    fs.writeFileSync(path.join(home, ".summer", "config.json"), JSON.stringify({ schemaVersion: 1, gateway: { url: "https://cfg.example.com" } }));
    expect(resolveEmbedEndpoint({}, home)).toEqual({ url: "https://cfg.example.com/api/mcp/embed", token: "file-tok", source: "gateway" });
    fs.rmSync(path.join(home, ".summer", "config.json"));
    expect(resolveEmbedEndpoint({}, home).url).toBe("https://www.summerengine.com/api/mcp/embed");
  });
});
