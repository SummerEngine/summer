import { describe, expect, it } from "vitest";
import { redactLogLine, redactSensitive, redactText } from "./redact.js";

describe("redactSensitive", () => {
  it("blanks sensitive keys at any depth and leaves other data alone", () => {
    const out = redactSensitive({
      event: "x",
      authToken: "abc",
      nested: [{ Authorization: "Bearer zzz", ok: true }],
      apiKey: "k",
      api_key: "k2",
    }) as Record<string, unknown>;
    expect(out).toEqual({
      event: "x",
      authToken: "[REDACTED]",
      nested: [{ Authorization: "[REDACTED]", ok: true }],
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
    });
  });

  it("honours extra key patterns and scrubs string values on request", () => {
    const out = redactSensitive(
      { hostname: "box", message: "auth failed: Bearer abcdefgh12345678" },
      { extraKeys: /hostname/i, strings: true }
    ) as Record<string, string>;
    expect(out.hostname).toBe("[REDACTED]");
    expect(out.message).toBe("auth failed: Bearer [REDACTED]");
  });
});

describe("redactText", () => {
  it("scrubs bearer tokens, key=value secrets, and known credential shapes", () => {
    expect(redactText("Authorization: Bearer eyJabc.def.ghi failed")).toBe(
      "Authorization: Bearer [REDACTED] failed"
    );
    expect(redactText("retry with token=abc123 and api_key: xyz")).toBe(
      "retry with token=[REDACTED] and api_key: [REDACTED]"
    );
    expect(redactText(`bad creator token sc_${"c".repeat(43)} rejected`)).toBe(
      "bad creator token [REDACTED] rejected"
    );
    expect(redactText("no secrets here, just a path /Users/me/game")).toBe(
      "no secrets here, just a path /Users/me/game"
    );
  });
});

describe("redactLogLine", () => {
  it("redacts both structured keys and free-text values of a JSONL line", () => {
    const line = JSON.stringify({
      event: "mcp:tool_error",
      token: "abc",
      error: "gateway said 401 for Bearer abcdefgh12345678",
    });
    const out = JSON.parse(redactLogLine(line));
    expect(out).toEqual({
      event: "mcp:tool_error",
      token: "[REDACTED]",
      error: "gateway said 401 for Bearer [REDACTED]",
    });
  });

  it("scrubs non-JSON lines as text", () => {
    expect(redactLogLine("plain line password=hunter2")).toBe("plain line password=[REDACTED]");
  });
});
