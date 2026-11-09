import { describe, expect, it } from "vitest";
import { SignInLinks, signInKindForCode, signInLinkText, type SignInLinkDependencies } from "./sign-in-link.js";

function fakeDeps(overrides: Partial<SignInLinkDependencies> = {}) {
  const waits: Array<{ gatewayUrl: string; sessionId: string; cancelled: () => Promise<boolean>; finish: () => void }> = [];
  let id = 0;
  let token: string | null = null;
  const deps: SignInLinkDependencies = {
    gatewayUrl: async () => "https://gateway.example",
    randomId: () => `session-${++id}`,
    waitForAccount: (gatewayUrl, sessionId, cancelled) =>
      new Promise<void>((resolve) => waits.push({ gatewayUrl, sessionId, cancelled, finish: resolve })),
    runStore: async (onUrl) => {
      onUrl("https://auth.example/authorize?client_id=x");
    },
    accountToken: async () => token,
    now: () => 0,
    ...overrides,
  };
  return { deps, waits, setToken: (value: string | null) => (token = value) };
}

describe("sign-in links for cloud tools", () => {
  it("starts one cli_session sign-in and returns the same link until it finishes", async () => {
    const { deps, waits } = fakeDeps();
    const links = new SignInLinks(deps);
    const first = await links.link("account");
    expect(first).toBe("https://gateway.example/login?cli_session=session-1");
    expect(await links.link("account")).toBe(first);
    expect(waits).toHaveLength(1);
    waits[0].finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await links.link("account")).toBe("https://gateway.example/login?cli_session=session-2");
  });

  it("stops waiting when another sign-in saves a new token, not for the refused old one", async () => {
    const { deps, waits, setToken } = fakeDeps();
    setToken("old-refused-token");
    await new SignInLinks(deps).link("account");
    expect(await waits[0].cancelled()).toBe(false);
    setToken("new-token-from-the-app");
    expect(await waits[0].cancelled()).toBe(true);
  });

  it("returns the store approval link from the store sign-in", async () => {
    const { deps } = fakeDeps();
    expect(await new SignInLinks(deps).link("store")).toBe("https://auth.example/authorize?client_id=x");
  });

  it("maps only the sign-in codes and words the link for the person", () => {
    expect(signInKindForCode("not_signed_in")).toBe("account");
    expect(signInKindForCode("store_login_required")).toBe("store");
    expect(signInKindForCode("no_credits")).toBeNull();
    expect(signInLinkText("account", "https://x/login?cli_session=1")).toContain("without a restart");
  });
});
