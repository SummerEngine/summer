import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appCall,
  appCreate,
  appData,
  appDockArgsSchema,
  appDockOp,
  appEvents,
  appEventsArgsSchema,
  appPublish,
  appPublishArgsSchema,
  readAppDir,
  type AppsDeps,
  type AppsReply,
} from "./apps.js";

const APP = "22222222-2222-4222-8222-222222222222";

function fakeDeps(reply: Partial<AppsReply> = {}) {
  const request = vi.fn(async () => ({ ok: true, status: 200, data: {}, ...reply }) as AppsReply);
  return { request, deps: { request } as AppsDeps };
}

describe("summer_app_* cloud tools", () => {
  it("create returns the app and the next step", async () => {
    const { request, deps } = fakeDeps({ data: { app: { id: APP }, studio: { queued: true }, url: `/studio/apps/${APP}` } });
    const result = await appCreate({ name: "Loot table", format: "code" }, deps);
    expect(request).toHaveBeenCalledWith("POST", "/api/mcp/apps", { body: { name: "Loot table", format: "code" }, timeoutMs: 30_000 });
    expect(result).toMatchObject({ ok: true, app: { id: APP } });
    expect(String(result.next)).toContain("Studio tab is opening the app");
  });

  it("turns the server's {error: {code, message}} into one flat result with a hint", async () => {
    const { deps } = fakeDeps({ ok: false, status: 409, data: { error: { code: "app_not_open", message: "The app is not open", details: { href: "/studio/apps/x" } } } });
    const result = await appCall({ appId: APP, tool: "nerf_item", input: { id: "bow" } }, deps);
    expect(result).toMatchObject({ ok: false, code: "app_not_open", error: "The app is not open", status: 409, details: { href: "/studio/apps/x" } });
    expect(String(result.hint)).toContain("summer_app_data");
  });

  it("events long-poll with the server ceiling plus slack", async () => {
    const { request, deps } = fakeDeps({ data: { events: [], cursor: 4, timedOut: true } });
    await appEvents(appEventsArgsSchema.parse({ appId: APP, after: 4, waitSeconds: 50, kinds: ["agent", "tool"] }), deps);
    const [, endpoint, init] = request.mock.calls[0] as unknown as [string, string, { query: URLSearchParams; timeoutMs: number }];
    expect(endpoint).toBe(`/api/mcp/apps/${APP}/events`);
    expect(init.query.toString()).toBe("after=4&timeoutMs=50000&kinds=agent%2Ctool");
    expect(init.timeoutMs).toBe(70_000);
    expect(() => appEventsArgsSchema.parse({ appId: APP, waitSeconds: 51 })).toThrow();
  });

  it("data reads without ops and writes with them", async () => {
    const { request, deps } = fakeDeps();
    await appData({ appId: APP, collection: "items", limit: 50 }, deps);
    await appData({ appId: APP, limit: 200, ops: [{ op: "remove", collection: "items", recordId: "bow" }] }, deps);
    expect(request.mock.calls.map((call) => (call as unknown[]).slice(0, 2))).toEqual([
      ["GET", `/api/mcp/apps/${APP}/data`],
      ["POST", `/api/mcp/apps/${APP}/data`],
    ]);
  });
});

describe("summer_app_publish", () => {
  it("publishes a local folder: text as utf8, binaries as base64, dotfiles and node_modules skipped", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "summer-app-"));
    writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>");
    mkdirSync(path.join(dir, "img"));
    writeFileSync(path.join(dir, "img", "a.png"), Buffer.from([1, 2, 3]));
    writeFileSync(path.join(dir, ".env"), "SECRET=1");
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules", "x.js"), "1");
    expect(await readAppDir(dir)).toEqual([
      { path: "img/a.png", content: "AQID", encoding: "base64" },
      { path: "index.html", content: "<h1>hi</h1>", encoding: "utf8" },
    ]);

    const { request, deps } = fakeDeps({ data: { version: { version: 3 } } });
    const result = await appPublish(appPublishArgsSchema.parse({ appId: APP, dir, manifest: { name: "Loot" }, note: "v3" }), deps);
    expect(result).toMatchObject({ ok: true });
    expect(String(result.next)).toContain("Version 3");
    const body = (request.mock.calls[0] as unknown as [string, string, { body: Record<string, unknown> }])[2].body;
    expect(body).toMatchObject({ manifest: { name: "Loot" }, note: "v3" });
    expect((body.files as unknown[]).length).toBe(2);
  });

  it("takes exactly one of dir, files or layout", async () => {
    const { request, deps } = fakeDeps();
    expect(await appPublish(appPublishArgsSchema.parse({ appId: APP, manifest: { name: "x" } }), deps)).toMatchObject({ ok: false, code: "invalid" });
    expect(await appPublish(appPublishArgsSchema.parse({ appId: APP, layout: {}, files: [], manifest: { name: "x" } }), deps)).toMatchObject({ ok: false });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("summer_app_dock", () => {
  it("maps actions to the engine's app dock ops", () => {
    expect(appDockOp(appDockArgsSchema.parse({ appId: APP, slot: "bottom" }))).toEqual({ op: "OpenAppDock", appId: APP, slot: "bottom" });
    expect(appDockOp(appDockArgsSchema.parse({ action: "close", appId: APP }))).toEqual({ op: "CloseAppDock", appId: APP });
    expect(appDockOp(appDockArgsSchema.parse({ action: "list" }))).toEqual({ op: "ListAppDocks" });
    expect(() => appDockOp(appDockArgsSchema.parse({ action: "open" }))).toThrow(/needs appId/);
  });
});
