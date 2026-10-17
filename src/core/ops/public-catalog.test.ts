import { describe, expect, it, vi } from "vitest";
import { OAuthError } from "../oauth.js";
import { HostedUnreachableError } from "../hosted-mcp.js";
import { describeFromShipped, searchEverywhere } from "./cloud.js";
import { CONTRACT_VERSION, errorAnswer, isLocalOp, legacyNames, OP_NAME } from "./contract.js";
import { publicCatalog, shippedCloudEntries, shippedWireForm } from "./public-catalog.js";

/**
 * registry/operations/public-catalog.json is a byte copy of the hosted
 * server's catalog (`npm run sync:catalog`; `-- --check` compares it with
 * PublicSummerEngine main before a release). These tests catch the other
 * drift: the copy and this package's legacy-names.json must agree.
 */

/** Operations the hosted server still runs through their 3.x tool, so its public catalog does not list them yet. */
const BRIDGED = ["docs.workflows"];

describe("the shipped public catalog (registry/operations/public-catalog.json)", () => {
  const catalog = publicCatalog();
  const shipped = new Set(catalog.operations.map((op) => op.name));

  it("is a contract catalog with every operation named the contract's way", () => {
    expect(catalog.contract).toBe(CONTRACT_VERSION);
    expect(catalog.operations.length).toBeGreaterThan(200);
    for (const op of catalog.operations) expect(op.name).toMatch(OP_NAME);
  });

  it("lists every cloud operation legacy-names.json maps a 3.x name to", () => {
    const cloud = [...new Set(Object.values(legacyNames()).map((row) => row.op))].filter((op) => !isLocalOp(op));
    expect(cloud.filter((op) => !shipped.has(op)).sort()).toEqual([...BRIDGED].sort());
  });

  it("agrees with legacy-names.json on every 3.x name it lists", () => {
    for (const op of catalog.operations) for (const name of op.legacy ?? []) expect(legacyNames()[name]?.op, name).toBe(op.name);
  });

  it("leaves to this package exactly the operations this package runs", () => {
    expect(catalog.localOperations.filter((op) => !isLocalOp(op.name)).map((op) => op.name)).toEqual(BRIDGED);
  });

  it("gives search a row and describe a wire form for each cloud operation, and none for local ones", () => {
    const rows = shippedCloudEntries();
    expect(rows.some((row) => isLocalOp(row.name))).toBe(false);
    expect(rows.find((row) => row.name === "store.publish")).toMatchObject({ provider: "cloud", effect: "publish", approval: "owner", tags: expect.arrayContaining(["publish"]) });
    expect(rows.find((row) => row.name === "assets.generate_image")?.input?.properties).toHaveProperty("out");
    expect(shippedWireForm("store.publish")).toMatchObject({ contract: CONTRACT_VERSION, name: "store.publish", needsSignIn: true, input: { required: expect.arrayContaining(["gameId"]) } });
    expect(shippedWireForm("engine.add_node")).toBeNull();
    expect(shippedWireForm("no.such_op")).toBeNull();
  });
});

describe("search and describe without Summer's server", () => {
  const signedOut = vi.fn(async () => {
    throw new OAuthError("store_login_required", "This machine is not signed in to the Summer store.", 'Recovery: run "summer login".');
  });

  it("lists every cloud operation signed out, marked needsSignIn", async () => {
    const { items, warning } = await searchEverywhere("publish my game", { limit: 5 }, signedOut);
    expect(items[0]).toMatchObject({ name: "store.publish", needsSignIn: true, input: expect.any(Object) });
    expect(items.find((item) => item.name === "apps.publish_folder")?.needsSignIn).toBeUndefined();
    expect(items.some((item) => "topics" in item)).toBe(false);
    expect(warning).toMatch(/^Not signed in/);
  });

  it("lists them unmarked when the server is only unreachable, and says so", async () => {
    const offline = vi.fn(async () => {
      throw new HostedUnreachableError("The hosted Summer Engine MCP did not answer: fetch failed.", "Recovery: check the network.");
    });
    const { items, warning } = await searchEverywhere("lower my price", { limit: 3 }, offline);
    expect(items[0]).toMatchObject({ name: "pricing.set_base" });
    expect(items[0].needsSignIn).toBeUndefined();
    expect(warning).toContain("did not search");
  });

  it("lays the server's live rows over the shipped ones signed in", async () => {
    const live = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, status: "done", result: { items: [{ name: "store.publish", title: "Ask the owner to publish", summary: "Live summary.", effect: "publish", approval: "owner", provider: "cloud", status: "stable", available: true, mcpTool: "summer_store_publish", input: { type: "object" } }] } }) }],
    }));
    const { items, warning } = await searchEverywhere("publish my game", { limit: 3 }, live);
    expect(warning).toBeNull();
    expect(items[0]).toMatchObject({ name: "store.publish", summary: "Live summary.", mcpTool: "summer_store_publish", tags: expect.arrayContaining(["publish"]) });
    expect(items[0].needsSignIn).toBeUndefined();
  });

  it("describes a cloud operation from the shipped catalog when the server cannot answer", () => {
    const answer = describeFromShipped("summer_store_submit", errorAnswer("not_signed_in", "No sign-in."));
    expect(answer).toMatchObject({ ok: true, status: "done", result: { operation: { name: "store.publish" } }, warnings: [expect.stringMatching(/^Not signed in/)] });
    expect(describeFromShipped("no.such_op", errorAnswer("not_signed_in", "No sign-in."))).toBeNull();
    expect(describeFromShipped("store.publish", errorAnswer("not_found", "No operation is named store.publish."))).toBeNull();
    expect(describeFromShipped("store.publish", { ok: true, status: "done", result: {} })).toBeNull();
  });
});
