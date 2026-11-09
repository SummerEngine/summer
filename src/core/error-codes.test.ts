import { describe, expect, it } from "vitest";
import {
  codedFailure,
  codeForStatus,
  describeNetworkError,
  engineNotRunningFromConnectError,
  networkDetails,
  RECOVERY,
} from "./error-codes.js";
import { engineNotRunningError } from "./engine.js";

describe("codedFailure", () => {
  it("puts ok, code, error and recovery first and keeps the tool's other fields", () => {
    const body = codedFailure("not_signed_in", "Not signed in to Summer.", { message: "Not signed in to Summer.", error: true, status: 401 });
    expect(Object.keys(body).slice(0, 4)).toEqual(["ok", "code", "error", "recovery"]);
    expect(body).toMatchObject({ ok: false, code: "not_signed_in", error: "Not signed in to Summer.", status: 401 });
    expect(body.recovery).toBe(RECOVERY.not_signed_in);
  });

  it("takes a tool's own recovery", () => {
    expect(codedFailure("no_credits", "Not enough credits.", {}, "Add credits.").recovery).toBe("Add credits.");
  });
});

describe("codeForStatus", () => {
  it("maps 401 and 402 to the shared codes and nothing else", () => {
    expect(codeForStatus(401)).toBe("not_signed_in");
    expect(codeForStatus(402)).toBe("no_credits");
    expect(codeForStatus(404)).toBeNull();
    expect(codeForStatus(500)).toBeNull();
  });
});

describe("describeNetworkError", () => {
  it("keeps the real cause that fetch hides behind 'fetch failed'", () => {
    const error = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:443") });
    expect(describeNetworkError(error)).toBe("fetch failed (connect ECONNREFUSED 127.0.0.1:443)");
  });

  it("returns the message alone when there is no cause", () => {
    expect(describeNetworkError(new Error("The operation was aborted due to timeout"))).toBe("The operation was aborted due to timeout");
  });

  it("puts the cause alone in details.cause", () => {
    const error = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND www.summerengine.com") });
    expect(networkDetails(error)).toEqual({ details: { cause: "getaddrinfo ENOTFOUND www.summerengine.com" } });
  });
});

describe("engineNotRunningFromConnectError", () => {
  it("words the no-editor case for the person, without token or registry paths", () => {
    const reason = engineNotRunningError({ port: 6550, token: null }, "/home/x/.summer").message;
    const error = engineNotRunningFromConnectError(reason);
    expect(error?.code).toBe("engine_not_running");
    expect(error?.message).toBe("Summer Engine is not running.");
    expect(error?.message).not.toMatch(/api-token/);
    expect(error?.reason).toBe(reason);
  });

  it("names the port of an editor that stopped answering", () => {
    const reason = engineNotRunningError({ port: 6551, token: "t" }, "/home/x/.summer").message;
    expect(engineNotRunningFromConnectError(reason)?.message).toBe("Summer Engine is not responding on port 6551.");
  });

  it("keeps the project named by an explicit selection", () => {
    const reason = "No running Summer editor matches /games/castle. Open that project in Summer Engine and retry.";
    expect(engineNotRunningFromConnectError(reason)?.message).toBe("No running Summer editor matches /games/castle.");
  });

  it("leaves other connect failures (several editors open) to their own text", () => {
    expect(
      engineNotRunningFromConnectError("Multiple Summer editors are running and this agent is not inside a Summer project.")
    ).toBeNull();
  });

  it("recommends a run command that names the project path", () => {
    expect(RECOVERY.engine_not_running).toMatch(/run <project-path>/);
  });
});
