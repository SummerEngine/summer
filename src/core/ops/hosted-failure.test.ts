import { describe, expect, it } from "vitest";
import { OAuthError } from "../oauth.js";
import { HostedCallError, hostedFailure } from "./hosted-failure.js";

describe("hosted call failures", () => {
  it("answers not_signed_in for the sign-in codes, with how to sign in", () => {
    for (const code of ["store_login_required", "store_login_expired", "oauth_token_invalid", "invalid_grant"]) {
      expect(hostedFailure(new OAuthError(code, "The sign-in is not valid.", "Recovery: run summer login."))).toEqual({
        ok: false,
        error: { code: "not_signed_in", message: "The sign-in is not valid.", next: { say: "Run: npx -y summer-engine login" }, retry: "no", details: { was: code } },
      });
    }
    expect(hostedFailure(new Error("Error POSTing to endpoint (HTTP 401): invalid_token"))).toMatchObject({ error: { code: "not_signed_in" } });
  });

  it("answers unavailable with the cause for an unreachable server or a failed sign-in step", () => {
    expect(hostedFailure(new HostedCallError("store_tools_unreachable", "The hosted Summer Engine MCP did not answer: fetch failed.", "Recovery: check the network."))).toEqual({
      ok: false,
      error: { code: "unavailable", message: "The hosted Summer Engine MCP did not answer: fetch failed.", next: { say: "check the network." }, retry: "after", details: { was: "store_tools_unreachable" } },
    });
    expect(hostedFailure(new OAuthError("oauth_network_failed", "Could not reach the sign-in server.", "Recovery: check the network."))).toMatchObject({ error: { code: "unavailable", details: { was: "oauth_network_failed" } } });
    expect(hostedFailure(new TypeError("fetch failed"))).toMatchObject({ error: { code: "unavailable", message: "The Summer server did not answer: fetch failed" } });
  });

  it("answers outcome_unknown for a call that was sent and timed out, so a write is not sent twice blindly", () => {
    expect(hostedFailure(new Error("MCP error -32001: Request timed out"))).toMatchObject({ error: { code: "outcome_unknown", retry: "same_key" } });
  });
});
