/**
 * The `summer preview` HTTP server: loopback only, one page and three routes.
 *
 *   GET  /            the page (./page.ts)
 *   GET  /api/frame   the newest frame (image bytes, status in x-summer-status),
 *                     or 503 + the status as JSON while no editor answers;
 *                     ?fresh=1 captures now (a check that needs the game as it is)
 *   GET  /api/status  the status as JSON, without capturing
 *   POST /api/input   {inputs:[{kind:"key",code,pressed} | {kind:"click",x,y,button}]}
 *                     to the running game
 *
 * Listens on 127.0.0.1 and, where the machine has it, on ::1 at the same port,
 * so http://localhost:<port> (what Claude Code Desktop's Browser pane opens)
 * reaches it either way. Requests must name a loopback Host (stops a web page
 * from reaching it through DNS rebinding); the API refuses requests a browser
 * marks as coming from another site (Sec-Fetch-Site), so another page cannot
 * make it capture with an <img>; input must be a same-origin JSON POST.
 *
 * No frame-ancestors in the CSP: Desktop's docs do not say how the Browser
 * pane hosts a page, and a frame-ancestors rule would blank it if the pane
 * frames it. Instead the page itself sends no input while it is framed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parsePreviewInputs } from "./input.js";
import { PREVIEW_PAGE_HTML } from "./page.js";
import { PreviewSource, type PreviewEngine } from "./preview-source.js";

export const PREVIEW_HOST = "127.0.0.1";
/** Ports tried after a taken default port. */
export const PORT_SEARCH_SPAN = 20;

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const MAX_INPUT_BODY_BYTES = 16 * 1024;

export interface PreviewServerOptions {
  /** First port to try. */
  port: number;
  /** true: that port or an error (a host that launched us expects it).
   *  false: the next free port up to PORT_SEARCH_SPAN above it. 0 = any. */
  strictPort: boolean;
  connect: () => Promise<PreviewEngine>;
  now?: () => number;
  /** Where failure details go (default stderr); the page gets a short fixed text. */
  log?: (line: string) => void;
}

export interface PreviewServer {
  url: string;
  port: number;
  source: PreviewSource;
  close(): Promise<void>;
}

export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is in use.`);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_INPUT_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function handler(source: PreviewSource, getPort: () => number) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const port = getPort();
    const hosts = allowedHosts(port);
    if (!hosts.has(req.headers.host ?? "")) {
      sendJson(res, 403, { ok: false, error: "Open the preview at http://127.0.0.1:" + port });
      return;
    }
    const [path, query = ""] = (req.url ?? "/").split("?");
    const site = req.headers["sec-fetch-site"];
    if (path!.startsWith("/api/") && (site === "cross-site" || site === "same-site")) {
      sendJson(res, 403, { ok: false, error: "The preview API answers only its own page." });
      return;
    }

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": CONTENT_SECURITY_POLICY,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(PREVIEW_PAGE_HTML);
      return;
    }

    if (req.method === "GET" && path === "/api/status") {
      sendJson(res, 200, source.status());
      return;
    }

    if (req.method === "GET" && path === "/api/frame") {
      const frame = await source.frame({ fresh: new URLSearchParams(query).get("fresh") === "1" });
      const status = source.status();
      if (!frame || status.state === "no_editor") {
        sendJson(res, 503, status);
        return;
      }
      res.writeHead(200, {
        "content-type": frame.mime,
        "content-length": frame.bytes.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-summer-status": encodeURIComponent(JSON.stringify(status)),
      });
      res.end(frame.bytes);
      return;
    }

    if (path === "/api/input") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "POST only" });
        return;
      }
      const origin = req.headers.origin;
      const sameOrigin = !origin || [...hosts].some((host) => origin === `http://${host}`);
      const json = (req.headers["content-type"] ?? "").split(";")[0]!.trim() === "application/json";
      if (!sameOrigin || !json) {
        sendJson(res, 403, { ok: false, error: "Input is taken only from the preview page (same origin, JSON)." });
        return;
      }
      const text = await readBody(req);
      let body: unknown = null;
      try {
        body = text === null ? null : JSON.parse(text);
      } catch {
        body = null;
      }
      const inputs = parsePreviewInputs(body);
      if (!inputs) {
        sendJson(res, 400, { ok: false, error: "Expected {inputs:[{kind:'key',code,pressed} | {kind:'click',x,y,button}]} (1 to 64)." });
        return;
      }
      const result = await source.sendInput(inputs);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found. The preview is at /" });
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function safe(handle: ReturnType<typeof handler>, log: (line: string) => void) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((err: unknown) => {
      // Details stay in the local log; the page gets a fixed answer.
      log(`summer preview: ${req.method} ${(req.url ?? "/").split("?")[0]} failed: ${err instanceof Error ? err.message : "unknown error"}`);
      if (res.headersSent) res.end();
      else sendJson(res, 500, { ok: false, error: "internal_error" });
    });
  };
}

/** Bind 127.0.0.1 (required) and ::1 (when the machine has IPv6) on one port. */
async function bindPair(port: number, handle: ReturnType<typeof handler>, log: (line: string) => void): Promise<Server[]> {
  const v4 = createServer(safe(handle, log));
  await listen(v4, port, PREVIEW_HOST);
  const bound = (v4.address() as AddressInfo).port;
  const v6 = createServer(safe(handle, log));
  try {
    await listen(v6, bound, "::1");
    return [v4, v6];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      // Something else answers localhost on this port over IPv6: the Browser
      // pane could reach it instead of us. Treat the port as taken.
      await closeServer(v4);
      throw err;
    }
    return [v4];
  }
}

export async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const source = new PreviewSource({ connect: options.connect, now: options.now, log });
  let port = options.port;
  const handle = handler(source, () => port);
  const last = options.strictPort || options.port === 0 ? options.port : options.port + PORT_SEARCH_SPAN;
  let servers: Server[] | null = null;
  for (let candidate = options.port; candidate <= last; candidate += 1) {
    try {
      servers = await bindPair(candidate, handle, log);
      port = (servers[0]!.address() as AddressInfo).port;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      if (candidate === last) throw new PortInUseError(options.strictPort ? options.port : candidate);
    }
  }
  const bound = servers!;
  return {
    url: `http://${PREVIEW_HOST}:${port}`,
    port,
    source,
    close: async () => {
      await Promise.all(bound.map(closeServer));
    },
  };
}
