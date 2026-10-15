import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Answer } from "./contract.js";
import { FileSaver, findGameProject, withOutField } from "./save-files.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-save-files-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fetch that answers each URL with its own text as the file. */
function fakeFetch(failing: string[] = []) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (failing.includes(href)) return new Response("gone", { status: 404 });
    return new Response(`bytes of ${href}`, { status: 200, headers: { "content-type": "image/png" } });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const done = (result: unknown): Answer => ({ ok: true, status: "done", result });
const image = (id: string, title = "Red barrel") => ({ assetId: id, title, fileUrl: `https://cdn.example.com/${id}.png`, thumbnailUrl: null, mimeType: "image/png" });

describe("the game project", () => {
  it("finds Godot, Unity, Unreal and three.js projects and their asset folders, from a subfolder too", async () => {
    const godot = join(root, "godot");
    await mkdir(join(godot, "scenes"), { recursive: true });
    await writeFile(join(godot, "project.godot"), "");
    expect(await findGameProject(join(godot, "scenes"))).toEqual({ root: godot, engine: "godot", assets: join(godot, "assets") });

    const unity = join(root, "unity");
    await mkdir(join(unity, "Assets"), { recursive: true });
    await mkdir(join(unity, "ProjectSettings"), { recursive: true });
    expect(await findGameProject(unity)).toMatchObject({ engine: "unity", assets: join(unity, "Assets", "Summer") });

    const unreal = join(root, "unreal");
    await mkdir(unreal, { recursive: true });
    await writeFile(join(unreal, "Shooter.uproject"), "{}");
    expect(await findGameProject(unreal)).toMatchObject({ engine: "unreal", assets: join(unreal, "Content", "Summer") });

    const three = join(root, "three");
    await mkdir(three, { recursive: true });
    await writeFile(join(three, "package.json"), JSON.stringify({ dependencies: { three: "^0.170.0" } }));
    expect(await findGameProject(three)).toMatchObject({ engine: "threejs", assets: join(three, "public", "assets") });
  });
});

describe("out", () => {
  it("is kept here and never sent on, for the operations that take it", () => {
    const files = new FileSaver({ saveByDefault: false });
    expect(files.take("assets.generate_image", { prompt: "barrel", out: " art/ " })).toEqual({ input: { prompt: "barrel" }, out: "art/" });
    expect(files.take("jobs.wait", { jobId: "gen:1", out: "models" })).toEqual({ input: { jobId: "gen:1" }, out: "models" });
    expect(files.take("games.list", { out: "x" })).toEqual({ input: { out: "x" } });
  });

  it("shows in the input of those operations only", () => {
    expect(withOutField("assets.get", { type: "object", properties: { assetId: { type: "string" } } })).toMatchObject({ properties: { assetId: { type: "string" }, out: { type: "string" } } });
    expect(withOutField("games.list", { type: "object" })).toEqual({ type: "object" });
  });

  it("saves each image into a folder and adds localPath beside its URL", async () => {
    const fetch = fakeFetch();
    const files = new FileSaver({ saveByDefault: false, cwd: () => root, fetch });
    const answer = await files.finish("assets.generate_image", done({ assets: [image("a1"), image("a2")], model: "m" }), "art");
    const assets = (answer as { result: { assets: Array<{ localPath: string }> } }).result.assets;
    expect(assets.map((asset) => asset.localPath)).toEqual([join(root, "art", "red-barrel.png"), join(root, "art", "red-barrel-2.png")]);
    expect(await readFile(assets[1].localPath, "utf8")).toBe("bytes of https://cdn.example.com/a2.png");
  });

  it("saves to a file path as named, and res:// lands in the Godot project", async () => {
    await writeFile(join(root, "project.godot"), "");
    const files = new FileSaver({ saveByDefault: false, cwd: () => root, fetch: fakeFetch() });
    const named = await files.finish("assets.generate_audio", done({ asset: { assetId: "s1", title: "Clash", fileUrl: "https://cdn.example.com/s1" } }), "sfx/clash.mp3");
    expect((named as { result: { asset: { localPath: string } } }).result.asset.localPath).toBe(join(root, "sfx", "clash.mp3"));
    const godot = await files.finish("assets.generate_image", done({ assets: [image("a1", "Icon")] }), "res://ui/");
    expect((godot as { result: { assets: Array<{ localPath: string }> } }).result.assets[0].localPath).toBe(join(root, "ui", "icon.png"));
  });

  it("reads assets.get's downloadUrl and file name", async () => {
    const fetch = fakeFetch();
    const files = new FileSaver({ saveByDefault: false, cwd: () => root, fetch });
    const answer = await files.finish(
      "assets.get",
      done({ assetId: "m1", fileName: "Goblin.glb", fileUrl: "https://cdn.example.com/raw", downloadUrl: "https://www.summerengine.com/api/download/m1", mimeType: "model/gltf-binary" }),
      "models"
    );
    expect(fetch).toHaveBeenCalledWith("https://www.summerengine.com/api/download/m1", expect.anything());
    expect((answer as { result: { localPath: string } }).result.localPath).toBe(join(root, "models", "goblin.glb"));
  });

  it("says what was not saved and keeps the answer", async () => {
    const files = new FileSaver({ saveByDefault: false, cwd: () => root, fetch: fakeFetch(["https://cdn.example.com/a1.png"]) });
    const answer = await files.finish("assets.generate_image", done({ assets: [image("a1")] }), "art");
    expect(answer).toMatchObject({ ok: true, status: "done", warnings: ["Not saved on this machine (a1): the download answered HTTP 404."] });
    const godot = await files.finish("assets.generate_image", done({ assets: [image("a1")] }), "res://art");
    expect((godot as { warnings: string[] }).warnings[0]).toContain("needs a Godot project");
  });
});

describe("the default folder", () => {
  it("is the project's asset folder in a session that saves by default", async () => {
    await mkdir(join(root, "Assets"));
    await mkdir(join(root, "ProjectSettings"));
    const files = new FileSaver({ saveByDefault: true, cwd: () => root, fetch: fakeFetch() });
    const answer = await files.finish("assets.generate_image", done({ assets: [image("a1")] }));
    expect((answer as { result: { assets: Array<{ localPath: string }> } }).result.assets[0].localPath).toBe(join(root, "Assets", "Summer", "red-barrel.png"));
  });

  it("is not used in a session with engine tools, or outside a project", async () => {
    await writeFile(join(root, "project.godot"), "");
    const fetch = fakeFetch();
    const engine = new FileSaver({ saveByDefault: false, cwd: () => root, fetch });
    const answer = done({ assets: [image("a1")] });
    expect(await engine.finish("assets.generate_image", answer)).toBe(answer);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("jobs", () => {
  const running: Answer = { ok: true, status: "running", job: { id: "gen:7", state: "queued" } };
  const waited = (id: string, kind: string, result: unknown): Answer => done({ job: { id, kind, state: "done", result }, finished: true, waitedSeconds: 40 });

  it("save the job's files when jobs.wait sees it finish, where the generate call said", async () => {
    const files = new FileSaver({ saveByDefault: false, cwd: () => root, fetch: fakeFetch() });
    expect(await files.finish("assets.generate_3d", running, "models")).toBe(running);
    const answer = await files.finish("jobs.wait", waited("gen:7", "gen", { assetId: "m1", fileUrl: "https://cdn.example.com/m1.glb", rigAssetId: "m1" }));
    expect((answer as { result: { job: { result: { localPath: string } } } }).result.job.result.localPath).toBe(join(root, "models", "m1.glb"));
  });

  it("save every motion clip once, and a job that is not a generation only with out", async () => {
    const fetch = fakeFetch();
    const files = new FileSaver({ saveByDefault: true, cwd: () => root, fetch });
    await writeFile(join(root, "project.godot"), "");
    const clips = { assetId: "c1", fileUrl: "https://cdn.example.com/c1.glb", asset: { id: "c1", fileUrl: "https://cdn.example.com/c1.glb" }, assets: [{ id: "c1", fileUrl: "https://cdn.example.com/c1.glb" }, { id: "c2", fileUrl: "https://cdn.example.com/c2.glb" }] };
    const answer = await files.finish("jobs.wait", waited("gen:9", "gen", clips));
    const result = (answer as { result: { job: { result: { localPath: string; assets: Array<{ localPath: string }> } } } }).result.job.result;
    expect(result.assets.map((clip) => clip.localPath)).toEqual([join(root, "assets", "c1.glb"), join(root, "assets", "c2.glb")]);
    expect(result.localPath).toBe(join(root, "assets", "c1.glb"));
    expect(fetch).toHaveBeenCalledTimes(2);

    const approval = waited("apr:a1", "apr", { fileUrl: "https://cdn.example.com/key-art.png" });
    expect(await files.finish("jobs.wait", approval)).toBe(approval);
  });

  it("leave an unfinished wait alone", async () => {
    const files = new FileSaver({ saveByDefault: true, cwd: () => root, fetch: fakeFetch() });
    const pending = done({ job: { id: "gen:7", kind: "gen", state: "running" }, finished: false });
    expect(await files.finish("jobs.wait", pending, "models")).toBe(pending);
  });
});

describe("ops.describe", () => {
  it("shows out in the input of an operation that takes it", async () => {
    const files = new FileSaver({ saveByDefault: false });
    const answer = await files.finish("ops.describe", done({ operation: { name: "assets.generate_video", input: { type: "object", properties: { prompt: { type: "string" } } } } }));
    expect(answer).toMatchObject({ result: { operation: { input: { properties: { prompt: { type: "string" }, out: { type: "string" } } } } } });
  });
});
