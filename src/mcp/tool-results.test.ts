import { describe, expect, it } from "vitest";
import { capText, compactJsonText, shapeToolResult, singleEditCounter, withSignInLink } from "./tool-results.js";

describe("compact JSON results", () => {
  it("re-serializes pretty JSON and leaves other text alone", () => {
    expect(compactJsonText(JSON.stringify({ a: 1, b: [1, 2] }, null, 2))).toBe('{"a":1,"b":[1,2]}');
    expect(compactJsonText("{ not json\n}")).toBe("{ not json\n}");
    expect(compactJsonText("# Heading\n{}")).toBe("# Heading\n{}");
    expect(compactJsonText('{"a":1}')).toBe('{"a":1}');
  });
});

describe("output caps", () => {
  it("cuts the text at the cap and says how to get the rest", () => {
    const [part] = capText([{ type: "text", text: "x".repeat(5000) }], 4000);
    expect(part.text).toMatch(/^x{4000}\n\n\[Truncated: 4000 of 5000 characters shown\. Call again with maxCharacters: 5000/);
  });

  it("keeps short results, images and the library feedback footer", () => {
    const short = [{ type: "text", text: "ok" }];
    expect(capText(short, 4000)).toBe(short);
    const body = `${"y".repeat(3000)}\n— entry_id: skill/x@abc. If this entry is wrong, report via summer_library_feedback.`;
    const out = capText([{ type: "image", data: "png" } as never, { type: "text", text: body }], 1000);
    expect(out[0]).toEqual({ type: "image", data: "png" });
    expect(out[1].text).toMatch(/\[Truncated: 1000 of \d+ characters shown/);
    expect(out[1].text).toMatch(/— entry_id: skill\/x@abc\. If this entry is wrong/);
  });

  it("caps across text blocks and keeps the error flag", () => {
    const result = shapeToolResult(
      { content: [{ type: "text", text: "a".repeat(600) }, { type: "text", text: "b".repeat(600) }], isError: true },
      { maxCharacters: 1000 }
    ) as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text.startsWith("b".repeat(400) + "\n\n[Truncated")).toBe(true);
  });

  it("compacts JSON before measuring, so pretty-print spaces never count", () => {
    const pretty = JSON.stringify({ nodes: Array.from({ length: 50 }, (_, i) => ({ name: `n${i}` })) }, null, 2);
    const result = shapeToolResult({ content: [{ type: "text", text: pretty }] }, { maxCharacters: 4000 }) as { content: Array<{ text: string }> };
    expect(result.content[0].text).toBe(JSON.stringify(JSON.parse(pretty)));
  });
});

describe("single scene edit hint", () => {
  it("speaks on the 4th single edit in a row, then every 6th", () => {
    const next = singleEditCounter();
    const hints = Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? next("summer_set_prop", false) : next("summer_add_node", false)));
    expect(hints.map((hint, i) => (hint ? i + 1 : null)).filter(Boolean)).toEqual([4, 10, 16]);
    expect(hints[3]).toMatch(/4 single scene edits in a row.*summer_run_script/);
  });

  it("does not count failures or reads, and a script resets the run", () => {
    const next = singleEditCounter();
    for (let i = 0; i < 3; i++) next("summer_set_prop", false);
    expect(next("summer_set_prop", true)).toBeNull();
    expect(next("summer_get_scene_tree", false)).toBeNull();
    expect(next("summer_run_script", false)).toBeNull();
    for (let i = 0; i < 3; i++) expect(next("summer_remove_node", false)).toBeNull();
    expect(next("summer_remove_node", false)).toMatch(/^Tip: 4 single/);
  });

  it("adds the hint as its own text block", () => {
    const result = shapeToolResult({ content: [{ type: "text", text: '{"ok":true}' }] }, { hint: "Tip" }) as { content: Array<{ text: string }> };
    expect(result.content.map((part) => part.text)).toEqual(['{"ok":true}', "Tip"]);
  });
});

describe("withSignInLink", () => {
  it("adds the link to a not_signed_in tool answer and leaves other answers alone", async () => {
    const links = { link: async () => "https://gateway.example/login?cli_session=abc" };
    const failure = { isError: true, content: [{ type: "text", text: '{"ok":false,"code":"not_signed_in"}' }] };
    const shaped = (await withSignInLink(failure, "not_signed_in", links)) as { content: Array<{ text: string }> };
    // The link goes inside the JSON answer, which stays parseable with its code.
    expect(shaped.content).toHaveLength(1);
    const answer = JSON.parse(shaped.content[0].text);
    expect(answer.code).toBe("not_signed_in");
    expect(answer.signInUrl).toBe("https://gateway.example/login?cli_session=abc");
    expect(answer.recovery).toContain("https://gateway.example/login?cli_session=abc");
    expect(await withSignInLink(failure, "no_credits", links)).toBe(failure);
    // The v4 shape keeps the code in error: the link goes there.
    const v4 = { isError: true, content: [{ type: "text", text: '{"ok":false,"error":{"code":"not_signed_in","message":"Not signed in to Summer.","retry":"no"}}' }] };
    const v4Answer = JSON.parse(((await withSignInLink(v4, "not_signed_in", links)) as { content: Array<{ text: string }> }).content[0].text);
    expect(v4Answer.error.code).toBe("not_signed_in");
    expect(v4Answer.error.signInUrl).toBe("https://gateway.example/login?cli_session=abc");
    // Plain text keeps the link in its own block.
    const plain = { isError: true, content: [{ type: "text", text: "Not signed in to Summer." }] };
    const plainShaped = (await withSignInLink(plain, "not_signed_in", links)) as { content: Array<{ text: string }> };
    expect(plainShaped.content[1].text).toContain("cli_session=abc");
    expect(await withSignInLink(failure, "not_signed_in", { link: async () => null })).toBe(failure);
  });

  it("gives the store approval link, not the account link, when a v4 cloud call lacks the store sign-in", async () => {
    const asked: string[] = [];
    const links = { link: async (kind: "account" | "store") => (asked.push(kind), kind === "store" ? "https://auth.example/authorize?client_id=c" : "https://gateway.example/login?cli_session=abc") };
    const store = { isError: true, content: [{ type: "text", text: '{"ok":false,"error":{"code":"not_signed_in","message":"Cloud operations need the Summer sign-in.","retry":"no","details":{"was":"store_login_required"}}}' }] };
    const answer = JSON.parse(((await withSignInLink(store, "not_signed_in", links)) as { content: Array<{ text: string }> }).content[0].text);
    expect(asked).toEqual(["store"]);
    expect(answer.error.signInUrl).toBe("https://auth.example/authorize?client_id=c");
    expect(answer.error.recovery).toMatch(/^Store approval link/);
    // Any other cause keeps the account link.
    const account = { isError: true, content: [{ type: "text", text: '{"ok":false,"error":{"code":"not_signed_in","message":"x","retry":"no","details":{"was":"http_401"}}}' }] };
    await withSignInLink(account, "not_signed_in", links);
    expect(asked).toEqual(["store", "account"]);
  });
});
