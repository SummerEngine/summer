/**
 * Sign-in links the MCP hands to the agent when a cloud tool needs a sign-in.
 *
 * An agent outside Summer (Claude Code, Codex, Cursor) cannot click a browser
 * for the person, and `summer login` blocks a terminal. So when a tool answers
 * `not_signed_in`, the long-lived MCP process starts the same `cli_session`
 * sign-in `summer login` uses, without opening anything, and returns its link;
 * the agent shows it, the person signs in, and the poll saves the token to
 * ~/.summer. The next call works: no restart, no reinstall. A
 * `store_login_required` answer gets the store's approval link the same way
 * (core/oauth.ts runStoreLogin, loopback callback on this machine).
 *
 * One pending sign-in of each kind per process: repeated failures return the
 * same link until it finishes or expires.
 */

import { randomUUID } from "crypto";
import { getAuthToken } from "./auth.js";
import { cliSessionLoginUrl, pollCliSession, POLL_TIMEOUT_MS } from "./cli-session.js";
import { resolveGatewayUrl } from "./config.js";
import { runStoreLogin } from "./oauth.js";

export type SignInKind = "account" | "store";

export interface SignInLinkDependencies {
  gatewayUrl: () => Promise<string>;
  randomId: () => string;
  /** Waits for the account sign-in and saves it; resolves when done. */
  waitForAccount: (gatewayUrl: string, sessionId: string, cancelled: () => Promise<boolean>) => Promise<unknown>;
  /** Runs the store approval; calls `onUrl` with its link, resolves when approved. */
  runStore: (onUrl: (url: string) => void) => Promise<unknown>;
  /** The saved account token, if any. */
  accountToken: () => Promise<string | null>;
  now: () => number;
}

/** Unref'd timers: a pending sign-in never keeps a finished process alive. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

const defaultDependencies: SignInLinkDependencies = {
  gatewayUrl: resolveGatewayUrl,
  randomId: randomUUID,
  waitForAccount: (gatewayUrl, sessionId, cancelled) =>
    pollCliSession(gatewayUrl, sessionId, { fetch, sleep, now: Date.now, log: () => {}, cancelled }),
  runStore: (onUrl) =>
    runStoreLogin({
      fetch: (input, init) => globalThis.fetch(input, init),
      now: Date.now,
      log: () => {},
      openUrl: async (url) => onUrl(url),
    }),
  accountToken: getAuthToken,
  now: Date.now,
};

interface Pending {
  url: Promise<string | null>;
  startedAt: number;
  done: boolean;
}

const STORE_LINK_WAIT_MS = 10_000;

export class SignInLinks {
  private pending = new Map<SignInKind, Pending>();

  constructor(private readonly deps: SignInLinkDependencies = defaultDependencies) {}

  /** The link for this kind of sign-in, starting the wait when none is pending; null when none can be made. */
  async link(kind: SignInKind): Promise<string | null> {
    const current = this.pending.get(kind);
    if (current && !current.done && this.deps.now() - current.startedAt < POLL_TIMEOUT_MS) {
      return current.url;
    }
    const pending: Pending = { url: Promise.resolve(null), startedAt: this.deps.now(), done: false };
    const finish = () => {
      pending.done = true;
    };
    if (kind === "account") {
      pending.url = (async () => {
        const gatewayUrl = await this.deps.gatewayUrl();
        const sessionId = this.deps.randomId();
        // Another sign-in (the app, `summer login`) may save a new token
        // first: stop then. A refused old token does not count.
        const before = await this.deps.accountToken().catch(() => null);
        const cancelled = async () => {
          const now = await this.deps.accountToken().catch(() => null);
          return Boolean(now) && now !== before;
        };
        void this.deps.waitForAccount(gatewayUrl, sessionId, cancelled).then(finish, finish);
        return cliSessionLoginUrl(gatewayUrl, sessionId);
      })().catch(() => {
        finish();
        return null;
      });
    } else {
      pending.url = new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), STORE_LINK_WAIT_MS);
        timer.unref();
        void this.deps
          .runStore((url) => {
            clearTimeout(timer);
            resolve(url);
          })
          .then(finish, finish)
          .finally(() => resolve(null));
      });
    }
    this.pending.set(kind, pending);
    const url = await pending.url;
    if (url === null) finish();
    return url;
  }
}

/** What the agent shows the person: the link, then what happens after. */
export function signInLinkText(kind: SignInKind, url: string): string {
  return kind === "account"
    ? `Sign-in link for the person: ${url}\nAsk them to open it and sign in to Summer. When they are done, call this tool again: it works without a restart or reinstall. Engine tools work without signing in.`
    : `Store approval link for the person: ${url}\nAsk them to open it on this computer and approve Summer. When they are done, call this tool again: it works without a restart.`;
}

/** The sign-in kind a tool error code asks for, if any. */
export function signInKindForCode(code: string | null): SignInKind | null {
  if (code === "not_signed_in") return "account";
  if (code === "store_login_required") return "store";
  return null;
}
