import { summerRequestHeaders } from "../agent-host.js";
import { resolveGatewayUrl } from "../config.js";
import { getStoreAccessToken, OAuthError } from "../oauth.js";
import { readJsonResponse } from "../util/http.js";

/**
 * Summer Router management calls from the CLI. They go the same way as the
 * other creator store commands (summer_publish_build): the store sign-in's
 * OAuth token ("summer login") as a bearer to summerengine.com's
 * /api/creator-store/*, which forwards to the platform's /v1/management/*.
 * The platform treats this token as the creator's agent: it may read
 * everything and push characters before the game is live; settings, limits
 * and deletes need the owner in Studio (owner_approval_required).
 *
 * Routes (under /v1/management):
 *   GET  router/registry
 *   GET  games/{g}/router/characters
 *   GET  games/{g}/router/characters/{id}
 *   PUT  games/{g}/router/characters/{id}?expected_version=n
 *   POST games/{g}/router/characters/{id}:test      (a scripted text turn)
 *   GET  games/{g}/router/settings
 *   PUT  games/{g}/router/settings
 *   GET  games/{g}/router/usage?days=n
 *   GET  games/{g}/router/logs?since=&limit=        (per-call records)
 *   GET  me/router/account-limit, PUT me/router/account-limit
 */

export const STORE_PROXY_PATH = "/api/creator-store";
const TIMEOUT_MS = 30_000;

export class RouterApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: {
      requestId?: string;
      retryable?: boolean;
      fix?: string;
      docsUrl?: string;
      studioUrl?: string;
      scope?: string;
      resetsAt?: string;
    } = {}
  ) {
    super(message);
    this.name = "RouterApiError";
  }
}

export interface RouterApiDependencies {
  fetch: typeof fetch;
  token: () => Promise<string>;
  gateway: () => Promise<string>;
}

export const defaultApiDependencies: RouterApiDependencies = {
  fetch: (input, init) => globalThis.fetch(input, init),
  token: () => getStoreAccessToken(),
  gateway: () => resolveGatewayUrl(),
};

export interface RouterApi {
  request<T = Record<string, unknown>>(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    options?: { body?: unknown; query?: Record<string, string | number | undefined> }
  ): Promise<T>;
}

export const seg = encodeURIComponent;

export function createRouterApi(deps: RouterApiDependencies = defaultApiDependencies): RouterApi {
  return {
    async request<T>(method: string, path: string, options: { body?: unknown; query?: Record<string, string | number | undefined> } = {}) {
      let token: string;
      try {
        token = await deps.token();
      } catch (error) {
        if (error instanceof OAuthError) {
          throw new RouterApiError(401, "not_signed_in", "This machine is not signed in to Summer.", {
            fix: 'Run "summer login" and approve in the browser, then retry.',
          });
        }
        throw error;
      }
      const url = new URL(`${await deps.gateway()}${STORE_PROXY_PATH}/${path}`);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
      }
      const headers: Record<string, string> = {
        ...summerRequestHeaders({ surface: "cli" }),
        authorization: `Bearer ${token}`,
        accept: "application/json",
      };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      let response: Response;
      try {
        response = await deps.fetch(url.toString(), {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new RouterApiError(0, "network_error", `Summer did not answer: ${error instanceof Error ? error.message : String(error)}.`, {
          retryable: true,
          fix: "Check the network and retry.",
        });
      }
      if (response.status === 204) return {} as T;
      const { json } = await readJsonResponse(response);
      if (response.ok) return (json ?? {}) as T;
      throw toApiError(response.status, json);
    },
  };
}

export function toApiError(status: number, json: unknown): RouterApiError {
  const body = (json && typeof json === "object" ? (json as Record<string, unknown>) : {}) as Record<string, unknown>;
  const error = (body.error && typeof body.error === "object" ? body.error : body) as Record<string, unknown>;
  const text = (key: string) => (typeof error[key] === "string" ? (error[key] as string) : undefined);
  const code = text("code") ?? (status === 401 ? "not_signed_in" : status === 404 ? "not_found" : `http_${status}`);
  return new RouterApiError(status, code === "unauthorized" ? "not_signed_in" : code, text("message") ?? `Summer refused the request (${status}).`, {
    requestId: text("requestId") ?? text("request_id"),
    retryable: typeof error.retryable === "boolean" ? error.retryable : undefined,
    fix: text("fix"),
    docsUrl: text("docsUrl"),
    studioUrl: text("studioUrl"),
    scope: text("scope"),
    resetsAt: text("resetsAt"),
  });
}
