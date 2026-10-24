import { describe, expect, it, vi } from "vitest";
import { runInAppStudio, type StudioPageClient } from "./studio-page.js";

const ADVERT = { studioPage: { version: 1, path: "/api/studio", ops: ["studio.map", "studio.page", "studio.use_page", "studio.read_form", "studio.submit_form"] } };
const terminal = (result: Record<string, unknown>) => ({ status: result.ok ? "ok" : "error", results: [{ op: "studio.page", ...result }] });

function app(answer: unknown, capabilities: StudioPageClient["getEngineCapabilities"] = () => ADVERT) {
  const studioPage = vi.fn(async () => answer);
  return { studioPage, engine: async (): Promise<StudioPageClient> => ({ getEngineCapabilities: capabilities, studioPage }) };
}

describe("Studio page ops in the running app's own Studio tab", () => {
  it("runs there when the app advertises studioPage, without the tabId, and answers in the one shape", async () => {
    const page = { path: "/studio?tab=assets", fields: [], actions: [] };
    const { studioPage, engine } = app(terminal({ ok: true, result: { page } }));
    expect(await runInAppStudio("studio.page", { tabId: "tab_browser01" }, engine)).toEqual({ ok: true, status: "done", result: { page } });
    expect(studioPage).toHaveBeenCalledWith("studio.page", {});
    const critical = app(terminal({ ok: true, result: { personConfirms: { label: "Publish", highlighted: true, message: "The person presses Publish." } } }));
    expect(await runInAppStudio("studio.use_page", { press: "store.publish" }, critical.engine)).toMatchObject({ ok: true, result: { personConfirms: { highlighted: true } } });
    const approval = app(terminal({ ok: true, result: { status: "needs_approval", approval: { id: "apr_1", url: "https://x", who: "person", summary: "s" }, job: { id: "apr:apr_1", state: "awaiting_approval" } } }));
    expect(await runInAppStudio("studio.submit_form", { form: "profile" }, approval.engine)).toMatchObject({ ok: true, status: "needs_approval", approval: { id: "apr_1" } });
    const refused = app(terminal({ ok: false, failure_reason: "not_found", error: "No form named x." }));
    expect(await runInAppStudio("studio.read_form", { form: "x" }, refused.engine)).toMatchObject({ ok: false, error: { code: "not_found", message: "No form named x." } });
    const late = app(terminal({ ok: false, failure_reason: "timeout", error: "Late." }));
    expect(await runInAppStudio("studio.use_page", {}, late.engine)).toMatchObject({ ok: false, error: { code: "outcome_unknown", next: { op: "studio.page" } } });
  });

  it("goes to Summer's server (null) when the app has no Studio tab, is not running, does not advertise it, or for other ops", async () => {
    expect(await runInAppStudio("studio.page", {}, app(terminal({ ok: false, failure_reason: "no_tab", error: "This app has no Studio tab." })).engine)).toBeNull();
    expect(await runInAppStudio("studio.page", {}, async () => { throw new Error("Summer Engine is not running."); })).toBeNull();
    const older = app(terminal({ ok: true, result: {} }), () => ({ navigation: { targets: [{ id: "studio" }] } }));
    expect(await runInAppStudio("studio.page", {}, older.engine)).toBeNull();
    expect(older.studioPage).not.toHaveBeenCalled();
    const other = app(terminal({ ok: true, result: {} }));
    expect(await runInAppStudio("studio.open", { target: "billing" }, other.engine)).toBeNull();
    expect(other.studioPage).not.toHaveBeenCalled();
  });
});
