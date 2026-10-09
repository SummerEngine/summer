import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  callHostedToolForCli,
  checkStoreAccess,
  listHostedToolsForCli,
  matchHostedTool,
  type HostedClient,
  type HostedConnectDependencies,
} from "./hosted-mcp.js";
import { OAuthError } from "./oauth.js";

const tool = (name: string): Tool => ({ name, description: `${name}.`, inputSchema: { type: "object" } });

function fakeDeps(callTool: HostedClient["callTool"], tools: Tool[] = [tool("summer_store_list_games")]): HostedConnectDependencies {
  const client: HostedClient = {
    listTools: async () => ({ tools }),
    callTool,
    listPrompts: async () => ({ prompts: [] }),
    getPrompt: async () => ({}),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({}),
  };
  return { url: () => "http://127.0.0.1:1/mcp", token: async () => "t", connect: async () => client };
}

const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

describe("store access through the hosted Summer Engine MCP", () => {
  it("is ok when the store lists the games", async () => {
    const result = await checkStoreAccess(1_000, fakeDeps(async () => text({ games: [{ gameId: "g1" }, { gameId: "g2" }] })));
    expect(result).toEqual({ status: "ok", games: 2 });
  });

  it("passes the refusal through with its code, message and request id", async () => {
    const result = await checkStoreAccess(
      1_000,
      fakeDeps(async () => text({ error: "not_signed_in", status: 401, requestId: "r1", message: "Summer Games does not accept AI-tool sign-in yet." }, true))
    );
    expect(result).toEqual({ status: "refused", code: "not_signed_in", message: "Summer Games does not accept AI-tool sign-in yet.", requestId: "r1" });
  });

  it("says not signed in when there is no store sign-in", async () => {
    const deps = fakeDeps(async () => text({}));
    deps.token = async () => {
      throw new OAuthError("store_login_required", "This machine is not signed in to the Summer store.", "Recovery: run it.");
    };
    expect((await checkStoreAccess(1_000, deps)).status).toBe("not_signed_in");
  });

  it("gives up after the timeout", async () => {
    const deps = fakeDeps(() => new Promise(() => undefined));
    expect((await checkStoreAccess(30, deps)).status).toBe("unreachable");
  });
});

describe("hosted tools from the CLI", () => {
  it("matches a hosted tool by name or slug", () => {
    const tools = [tool("summer_store_list_games")];
    expect(matchHostedTool("summer_store_list_games", tools)?.name).toBe("summer_store_list_games");
    expect(matchHostedTool("store-list-games", tools)?.name).toBe("summer_store_list_games");
    expect(matchHostedTool("nope", tools)).toBeNull();
  });

  it("calls a hosted tool with the store sign-in", async () => {
    const calls: unknown[] = [];
    const outcome = await callHostedToolForCli(
      "store-list-games",
      { a: 1 },
      fakeDeps(async (params) => {
        calls.push(params);
        return text({ games: [] });
      }),
      async () => true
    );
    expect(outcome.status).toBe("called");
    expect(calls).toEqual([{ name: "summer_store_list_games", arguments: { a: 1 } }]);
  });

  it("does not connect without a store sign-in", async () => {
    const deps = fakeDeps(async () => text({}));
    deps.connect = async () => {
      throw new Error("must not connect");
    };
    expect((await callHostedToolForCli("x", {}, deps, async () => false)).status).toBe("not_signed_in");
    expect((await listHostedToolsForCli(deps, async () => false)).status).toBe("not_signed_in");
  });
});
