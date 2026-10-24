import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Answer } from "./contract.js";
import { FileSaver, findGameProject, inSummerStore, isPrivateAddress, withOutField, type FileSaverOptions } from "./save-files.js";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "summer-save-files-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type FakeFile = { status?: number; body?: string; type?: string; headers?: Record<string, string> };

/** A fetch that answers each URL with its own text as the file, or what `files` says for it. */
function fakeFetch(files: Record<string, FakeFile> = {}) {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    const file = files[href] ?? {};
    return new Response(file.status && file.status >= 300 && file.status < 400 ? null : (file.body ?? `bytes of ${href}`), {
      status: file.status ?? 200,
      headers: { "content-type": file.type ?? "image/png", ...(file.headers ?? {}) },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

/** Every host is public unless named in `privateHosts`. */
const lookup = (privateHosts: string[] = []) => async (host: string) => [{ address: privateHosts.includes(host) ? "10.0.0.5" : "93.184.215.14" }];

function saver(options: Partial<FileSaverOptions> = {}) {
  return new FileSaver({ saveByDefault: false, cwd: () => root, fetch: fakeFetch(), lookup: lookup(), ...options });
}

const done = (result: unknown): Answer => ({ ok: true, status: "done", result });
const image = (id: string, title = "Red barrel") => ({ assetId: id, title, fileUrl: `https://cdn.example.com/${id}.png`, thumbnailUrl: null, mimeType: "image/png" });
const assetsOf = (answer: Answer) => (answer as { result: { assets: Array<{ localPath?: string }> } }).result.assets;
const warningsOf = (answer: Answer) => (answer as { warnings?: string[] }).warnings ?? [];

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

  it("stops at a repository root", async () => {
    await writeFile(join(root, "project.godot"), "");
    await mkdir(join(root, "tools", ".git"), { recursive: true });
    expect(await findGameProject(join(root, "tools"))).toBeNull();
  });
});

describe("out", () => {
  it("is kept here and never sent on, for the operations that take it", () => {
    const files = saver();
    expect(files.take("assets.generate_image", { prompt: "barrel", out: " art/ " })).toEqual({ input: { prompt: "barrel" }, out: "art/" });
    expect(files.take("jobs.wait", { jobId: "gen:1", out: "models" })).toEqual({ input: { jobId: "gen:1" }, out: "models" });
    expect(files.take("games.list", { out: "x" })).toEqual({ input: { out: "x" } });
  });

  it("shows in the input of those operations only", () => {
    expect(withOutField("assets.get", { type: "object", properties: { assetId: { type: "string" } } })).toMatchObject({ properties: { assetId: { type: "string" }, out: { type: "string" } } });
    expect(withOutField("games.list", { type: "object" })).toEqual({ type: "object" });
  });

  it("saves each image into a folder and adds localPath beside its URL", async () => {
    const answer = await saver().finish("assets.generate_image", done({ assets: [image("a1"), image("a2")], model: "m" }), "art");
    const assets = assetsOf(answer);
    expect(assets.map((asset) => asset.localPath)).toEqual([join(root, "art", "red-barrel.png"), join(root, "art", "red-barrel-2.png")]);
    expect(await readFile(assets[1].localPath!, "utf8")).toBe("bytes of https://cdn.example.com/a2.png");
    expect((await readdir(join(root, "art"))).sort()).toEqual(["red-barrel-2.png", "red-barrel.png"]);
  });

  it("saves to a file path as named, and res:// lands in the Godot project", async () => {
    await writeFile(join(root, "project.godot"), "");
    const files = saver();
    const named = await files.finish("assets.generate_audio", done({ asset: { assetId: "s1", title: "Clash", fileUrl: "https://cdn.example.com/s1" } }), "sfx/clash.mp3");
    expect((named as { result: { asset: { localPath: string } } }).result.asset.localPath).toBe(join(root, "sfx", "clash.mp3"));
    const godot = await files.finish("assets.generate_image", done({ assets: [image("a1", "Icon")] }), "res://ui/");
    expect(assetsOf(godot)[0].localPath).toBe(join(root, "ui", "icon.png"));
  });

  it("saves a stored video as its .ogv rendition in a Godot project, and as is elsewhere", async () => {
    const clip = "https://res.cloudinary.com/summer/video/upload/v1/summer_art/u_clip_1.mp4";
    const video = { asset: { assetId: "v1", title: "Title loop", fileUrl: clip, fileName: "clip.mp4", mimeType: "video/mp4" } };
    const elsewhere = saver({ fetch: fakeFetch({ [clip]: { type: "video/mp4" } }) });
    const plain = await elsewhere.finish("assets.generate_video", done(video), "clips/");
    expect((plain as { result: { asset: { localPath: string } } }).result.asset.localPath).toBe(join(root, "clips", "clip.mp4"));

    await writeFile(join(root, "project.godot"), "");
    const fetch = fakeFetch({ [clip]: { type: "video/mp4" } });
    const godot = await saver({ fetch }).finish("assets.generate_video", done(video), "res://ui/title_bg.mp4");
    expect((godot as { result: { asset: { localPath: string } } }).result.asset.localPath).toBe(join(root, "ui", "title_bg.ogv"));
    expect(String(fetch.mock.calls[0]![0])).toBe("https://res.cloudinary.com/summer/video/upload/c_limit,h_1080,w_1920/v1/summer_art/u_clip_1.ogv");
    expect(warningsOf(godot).join(" ")).toContain("Ogg Theora");
  });

  it("reads assets.get's downloadUrl and file name", async () => {
    const fetch = fakeFetch();
    const answer = await saver({ fetch }).finish(
      "assets.get",
      done({ assetId: "m1", fileName: "Goblin.glb", fileUrl: "https://cdn.example.com/raw", downloadUrl: "https://www.summerengine.com/api/download/m1", mimeType: "model/gltf-binary" }),
      "models"
    );
    expect(fetch).toHaveBeenCalledWith("https://www.summerengine.com/api/download/m1", expect.anything());
    expect((answer as { result: { localPath: string } }).result.localPath).toBe(join(root, "models", "goblin.glb"));
  });

  it("says what was not saved and keeps the answer", async () => {
    const files = saver({ fetch: fakeFetch({ "https://cdn.example.com/a1.png": { status: 404 } }) });
    const answer = await files.finish("assets.generate_image", done({ assets: [image("a1")] }), "art");
    expect(answer).toMatchObject({ ok: true, status: "done", warnings: ["Not saved on this machine (a1): the download answered HTTP 404."] });
    const godot = await files.finish("assets.generate_image", done({ assets: [image("a1")] }), "res://art");
    expect(warningsOf(godot)[0]).toContain("needs a Godot project");
    const empty = await files.finish("assets.generate_image", done({ assets: [] }), "art");
    expect(warningsOf(empty)).toEqual(["out: this answer names no file, so nothing was saved on this machine."]);
  });
});

describe("safety", () => {
  it("gives parallel saves of the same name each their own file", async () => {
    const files = saver();
    const answers = await Promise.all([1, 2, 3, 4].map((n) => files.finish("assets.generate_image", done({ assets: [image(`a${n}`)] }), "art")));
    const paths = answers.map((answer) => assetsOf(answer)[0].localPath!);
    expect(new Set(paths).size).toBe(4);
    expect((await readdir(join(root, "art"))).sort()).toEqual(["red-barrel-2.png", "red-barrel-3.png", "red-barrel-4.png", "red-barrel.png"]);
    for (const [index, path] of paths.entries()) expect(await readFile(path, "utf8")).toBe(`bytes of https://cdn.example.com/a${index + 1}.png`);
  });

  it("never fails the answer, and reads the working folder only when it saves", async () => {
    const gone = () => {
      throw Object.assign(new Error("ENOENT: process.cwd failed"), { code: "ENOENT" });
    };
    const made = done({ assets: [image("a1")] });
    const answer = await saver({ cwd: gone }).finish("assets.generate_image", made, "art");
    expect(answer).toMatchObject({ ok: true, status: "done", result: { assets: [{ assetId: "a1" }] } });
    expect(warningsOf(answer)[0]).toContain("Not saved on this machine: ENOENT");
    expect(await saver({ cwd: gone }).finish("assets.generate_image", made)).toBe(made);
  });

  it("never overwrites a file: it saves next to it and says so", async () => {
    await writeFile(join(root, "project.godot"), "config");
    await writeFile(join(root, "hero.png"), "old hero");
    const files = saver();
    const godot = await files.finish("assets.generate_image", done({ assets: [image("a1")] }), "project.godot");
    expect(assetsOf(godot)[0].localPath).toBe(join(root, "project.png"));
    expect(warningsOf(godot)[0]).toContain(".godot is not a media or model file type");
    expect(await readFile(join(root, "project.godot"), "utf8")).toBe("config");

    const hero = await files.finish("assets.generate_image", done({ assets: [image("a2")] }), "hero.png");
    expect(assetsOf(hero)[0].localPath).toBe(join(root, "hero-2.png"));
    expect(warningsOf(hero)[0]).toContain("already exists");
    expect(await readFile(join(root, "hero.png"), "utf8")).toBe("old hero");
  });

  it("refuses a res:// path that leaves the Godot project", async () => {
    const project = join(root, "game");
    await mkdir(project);
    await writeFile(join(project, "project.godot"), "");
    const fetch = fakeFetch();
    const answer = await saver({ cwd: () => project, fetch }).finish("assets.generate_image", done({ assets: [image("a1")] }), "res://../outside/x.png");
    expect(warningsOf(answer)[0]).toContain("is outside the Godot project");
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["game"]);
  });

  it("never saves into Summer's own folders: a game's .summer/local or ~/.summer", async () => {
    const project = join(root, "game");
    await mkdir(join(project, ".summer", "local"), { recursive: true });
    await writeFile(join(project, "project.godot"), "");
    const fetch = fakeFetch();
    for (const out of ["res://.summer/local/x.png", "res://.Summer/Local/", join(project, ".summer", "local", "git"), "~/.summer/x.png"]) {
      const answer = await saver({ cwd: () => project, fetch }).finish("assets.generate_image", done({ assets: [image("a1")] }), out);
      expect(warningsOf(answer)[0]).toContain("is Summer's own folder");
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(join(project, ".summer", "local"))).toEqual([]);
    // The game's memory beside the store is an ordinary folder.
    expect(inSummerStore(join(project, ".summer", "memory", "x.png"))).toBe(false);
  });

  it("downloads only from public https hosts, follows redirects only there, and caps the size", async () => {
    const files = saver({
      lookup: lookup(["intranet.example.com"]),
      maxBytes: 10,
      fetch: fakeFetch({
        "https://cdn.example.com/moved.png": { status: 302, headers: { location: "https://intranet.example.com/x.png" } },
        "https://cdn.example.com/big.png": { body: "more than ten bytes" },
        "https://cdn.example.com/declared.png": { body: "small", headers: { "content-length": "999999" } },
      }),
    });
    const urls = ["http://cdn.example.com/a.png", "https://127.0.0.1/a.png", "https://[::1]/a.png", "https://intranet.example.com/a.png", "https://cdn.example.com/moved.png", "https://cdn.example.com/big.png", "https://cdn.example.com/declared.png"];
    const answer = await files.finish("assets.generate_image", done({ assets: urls.map((fileUrl, n) => ({ assetId: `a${n}`, title: "x", fileUrl })) }), "art");
    expect(assetsOf(answer).every((asset) => asset.localPath === undefined)).toBe(true);
    const warnings = warningsOf(answer).join("\n");
    expect(warnings).toContain("only https downloads are saved");
    expect(warnings).toContain("127.0.0.1 is a private or local address");
    expect(warnings).toContain("::1 is a private or local address");
    expect(warnings).toContain("intranet.example.com is a private or local address");
    expect(warnings.match(/larger than 10 bytes/g)).toHaveLength(2);
    expect(await readdir(join(root, "art"))).toEqual([]);
    expect(isPrivateAddress("172.20.1.1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.4")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("refuses IPv4-mapped IPv6 in hex and NAT64 forms of private addresses", async () => {
    // The URL parser writes [::ffff:127.0.0.1] as [::ffff:7f00:1].
    for (const address of ["::ffff:7f00:1", "::ffff:a00:1", "64:ff9b::7f00:1", "::7f00:1"]) expect(isPrivateAddress(address), address).toBe(true);
    const fetch = fakeFetch();
    const answer = await saver({ fetch }).finish("assets.generate_image", done({ assets: [{ assetId: "a1", fileUrl: "https://[::ffff:127.0.0.1]/a.png" }] }), "art");
    expect(warningsOf(answer)[0]).toContain("is a private or local address");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes only media and model file types", async () => {
    const files = saver({
      fetch: fakeFetch({
        "https://cdn.example.com/Editor.cs": { type: "text/plain" },
        "https://cdn.example.com/t.dll": { type: "application/octet-stream" },
        "https://cdn.example.com/script": { type: "image/png" },
      }),
    });
    const answer = await files.finish(
      "assets.generate_image",
      done({
        assets: [
          { assetId: "c1", fileName: "Editor.cs", fileUrl: "https://cdn.example.com/Editor.cs" },
          { assetId: "d1", title: "t", fileUrl: "https://cdn.example.com/t.dll" },
          { assetId: "p1", fileName: "Shot.cs", fileUrl: "https://cdn.example.com/script" },
        ],
      }),
      "lib"
    );
    expect(assetsOf(answer).map((asset) => asset.localPath)).toEqual([join(root, "lib", "editor.bin"), join(root, "lib", "t.bin"), join(root, "lib", "shot.png")]);
  });
});

describe("the default folder", () => {
  it("is the project's asset folder for a generation in a session that saves by default", async () => {
    await mkdir(join(root, "Assets"));
    await mkdir(join(root, "ProjectSettings"));
    const answer = await saver({ saveByDefault: true }).finish("assets.generate_image", done({ assets: [image("a1")] }));
    expect(assetsOf(answer)[0].localPath).toBe(join(root, "Assets", "Summer", "red-barrel.png"));
  });

  it("is not used by assets.get (a read), in a session with engine tools, or outside a project", async () => {
    await writeFile(join(root, "project.godot"), "");
    const fetch = fakeFetch();
    const read = done({ assetId: "m1", fileUrl: "https://cdn.example.com/m1.glb" });
    expect(await saver({ saveByDefault: true, fetch }).finish("assets.get", read)).toBe(read);
    const made = done({ assets: [image("a1")] });
    expect(await saver({ saveByDefault: false, fetch }).finish("assets.generate_image", made)).toBe(made);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("jobs", () => {
  const running: Answer = { ok: true, status: "running", job: { id: "gen:7", state: "queued" } };
  const waited = (id: string, kind: string, result: unknown): Answer => done({ job: { id, kind, state: "done", result }, finished: true, waitedSeconds: 40 });

  it("save the job's files when jobs.wait sees it finish, where the generate call said", async () => {
    const files = saver();
    expect(await files.finish("assets.generate_3d", running, "models")).toBe(running);
    const answer = await files.finish("jobs.wait", waited("gen:7", "gen", { assetId: "m1", fileUrl: "https://cdn.example.com/m1.glb", rigAssetId: "m1" }));
    expect((answer as { result: { job: { result: { localPath: string } } } }).result.job.result.localPath).toBe(join(root, "models", "m1.glb"));
  });

  it("keep out through an approval that runs on as a generation job", async () => {
    const files = saver();
    const approval: Answer = { ok: true, status: "needs_approval", approval: { id: "op1", url: "https://www.summerengine.com/studio/approvals/op1", who: "person", summary: "Spend credits" }, job: { id: "apr:op1", state: "awaiting_approval" } };
    await files.finish("assets.generate_3d", approval, "models");
    const approved = waited("apr:op1", "apr", { status: "running", job: { id: "gen:9", state: "queued" } });
    expect(await files.finish("jobs.wait", approved)).toBe(approved);
    const answer = await files.finish("jobs.wait", waited("gen:9", "gen", { assetId: "m9", fileUrl: "https://cdn.example.com/m9.glb" }));
    expect((answer as { result: { job: { result: { localPath: string } } } }).result.job.result.localPath).toBe(join(root, "models", "m9.glb"));
  });

  it("keep the out of a wait that ended before the job did", async () => {
    const files = saver();
    await files.finish("jobs.wait", done({ job: { id: "gen:3", kind: "gen", state: "running" }, finished: false }), "models");
    const answer = await files.finish("jobs.wait", waited("gen:3", "gen", { assetId: "m3", fileUrl: "https://cdn.example.com/m3.glb" }));
    expect((answer as { result: { job: { result: { localPath: string } } } }).result.job.result.localPath).toBe(join(root, "models", "m3.glb"));
  });

  it("save every motion clip once, and a job that is not a generation only with out", async () => {
    const fetch = fakeFetch();
    const files = saver({ saveByDefault: true, fetch });
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

  it("reuse a default save when the same finished job is waited on again", async () => {
    const fetch = fakeFetch();
    const files = saver({ saveByDefault: true, fetch });
    await writeFile(join(root, "project.godot"), "");
    const model = { assetId: "m1", fileUrl: "https://cdn.example.com/m1.glb" };
    const pathOf = (answer: Answer) => (answer as { result: { job: { result: { localPath: string } } } }).result.job.result.localPath;
    const first = await files.finish("jobs.wait", waited("gen:4", "gen", model));
    const again = await files.finish("jobs.wait", waited("gen:4", "gen", model));
    expect(pathOf(again)).toBe(pathOf(first));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readdir(join(root, "assets"))).toEqual(["m1.glb"]);
  });
});

describe("ops.describe", () => {
  it("shows out in the input of an operation that takes it", async () => {
    const answer = await saver().finish("ops.describe", done({ operation: { name: "assets.generate_video", input: { type: "object", properties: { prompt: { type: "string" } } } } }));
    expect(answer).toMatchObject({ result: { operation: { input: { properties: { prompt: { type: "string" }, out: { type: "string" } } } } } });
  });
});
