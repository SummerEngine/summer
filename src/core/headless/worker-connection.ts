import { createHash } from "node:crypto";
import { asRecord } from "../util/json.js";
import { createConnection, type Socket } from "node:net";
import {
  envMs,
  HeadlessTimeoutError,
  LONG_RUNNING_OPS,
  MUTATING_OPS,
  scrubSecrets,
  WorkerOpError,
  type CallOptions,
  type ProjectConnection,
} from "./connection.js";

/**
 * TCP client for a headless Summer worker — protocol v1.1.
 *
 * Wire protocol (pinned v1.1; the worker implements the same):
 *   - connect to 127.0.0.1:<port>
 *   - WORKER sends first (within 3s):
 *       {"hello":{"pid":<int>,"nonce":"<32 hex>","proof":"<hex sha256(nonce + ':' + token)>"}}
 *   - client verifies `proof` against the REGISTRY token (proves the worker
 *     holds the token without it crossing the wire) AND `hello.pid` against
 *     the REGISTRY pid (pid-reuse / port-squat detection), then answers:
 *       {"auth":"<hex sha256('client:' + nonce + ':' + token)>"}
 *     The raw token NEVER crosses the wire in either direction.
 *   - then requests:        {"id": "...", "op": "...", "params": {...}}
 *   - responses:            {"id": "...", "ok": true, "result": ...}
 *                        or {"id": "...", "ok": false, "error": "..."}
 *   - interim progress:     {"id": "...", "event": "progress", "progress": ...}
 * All lines are newline-delimited JSON, one document per \n. Framing is done
 * on BYTES (split on 0x0a before utf-8 decoding) so a multibyte codepoint
 * split across TCP chunks is never corrupted. An un-terminated frame is
 * capped at 8MiB — beyond that the connection is destroyed with a clear
 * error.
 *
 * Timeouts (env-overridable; every timeout is a HeadlessTimeoutError naming
 * its stage):
 *   - connect: SUMMER_WORKER_CONNECT_TIMEOUT_MS (default 5s)   stage "connect"
 *   - hello:   SUMMER_WORKER_HELLO_TIMEOUT_MS (default 3s)     stage "auth"
 *   - per-op INACTIVITY: SUMMER_WORKER_OP_TIMEOUT_MS (30s) or
 *     SUMMER_WORKER_LONG_OP_TIMEOUT_MS (300s) for LONG_RUNNING_OPS. Progress
 *     lines RESTART the timer; the timer only STARTS once the request has
 *     flushed to the socket (write backpressure never eats the budget).
 *
 * Quarantine: when a MUTATING op (MUTATING_OPS) times out, the mutation's
 * outcome is UNKNOWN — the connection is destroyed and reports drift via
 * credentialsChanged()/isAlive() so caches evict it. The surfaced error says
 * so explicitly; callers must inspect the target before retrying. Read-only
 * timeouts leave the connection usable.
 *
 * Security: no token material ever appears in an error, log line, or thrown
 * value. Auth-phase failures surface FIXED messages (never worker-supplied
 * text); op errors from the worker are scrubbed of the token as defense in
 * depth.
 *
 * Failure model: a dropped socket fails ALL pending calls with a clean error
 * and marks the connection permanently dead. No transparent reconnect — the
 * worker may have died mid-mutation and this client sends no idempotency
 * keys, so a blind retry could double-apply (same reasoning as withEngine's
 * narrow retry policy). Callers evict and re-resolve.
 */

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_HELLO_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

export interface WorkerConnectOptions {
  host?: string;
  port: number;
  token: string;
  /** Registry pid for this worker — verified against hello.pid. */
  pid: number;
  projectPath: string;
  /** TCP connect budget. Default: SUMMER_WORKER_CONNECT_TIMEOUT_MS or 5s. */
  connectTimeoutMs?: number;
  /** Budget for the worker's hello line.
   *  Default: SUMMER_WORKER_HELLO_TIMEOUT_MS or 3s. */
  helloTimeoutMs?: number;
  /** Verify the channel with a `ping` op after the handshake. Default true. */
  verifyWithPing?: boolean;
  /** Un-terminated frame cap in bytes (test seam). Default MAX_FRAME_BYTES. */
  maxFrameBytes?: number;
}

interface PendingCall {
  op: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: unknown) => void;
  timer: NodeJS.Timeout | null;
  restartTimer: () => void;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** v1.1: what the WORKER must present in hello.proof. */
export function helloProof(nonce: string, token: string): string {
  return sha256Hex(`${nonce}:${token}`);
}

/** v1.1: what the CLIENT answers with in the auth line. */
export function clientAuthProof(nonce: string, token: string): string {
  return sha256Hex(`client:${nonce}:${token}`);
}

export function defaultOpTimeoutMs(op: string): number {
  return LONG_RUNNING_OPS.has(op)
    ? envMs("SUMMER_WORKER_LONG_OP_TIMEOUT_MS", 300_000)
    : envMs("SUMMER_WORKER_OP_TIMEOUT_MS", 30_000);
}

/** Read the first \n-terminated line off a raw socket (byte-exact; the
 *  remainder after the newline is returned untouched for the connection's
 *  frame buffer). Fixed error messages only — this runs pre-auth. */
function readFirstLine(
  socket: Socket,
  timeoutMs: number
): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(NEWLINE);
      if (newline >= 0) {
        const line = buffer.subarray(0, newline).toString("utf-8");
        const rest = Buffer.from(buffer.subarray(newline + 1));
        settled = true;
        cleanup();
        resolve({ line, rest });
        return;
      }
      if (buffer.length > MAX_HELLO_BYTES) {
        fail(
          new HeadlessTimeoutError(
            "auth",
            "Headless worker handshake failed: oversized hello frame."
          )
        );
      }
    };
    const onClose = () =>
      fail(
        new HeadlessTimeoutError(
          "auth",
          "Headless worker handshake failed: connection closed before hello."
        )
      );
    const timer = setTimeout(
      () =>
        fail(
          new HeadlessTimeoutError(
            "auth",
            `Headless worker handshake failed: no hello within ${timeoutMs}ms.`
          )
        ),
      timeoutMs
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onClose);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onClose);
  });
}

export class WorkerConnection implements ProjectConnection {
  readonly kind = "worker" as const;
  readonly projectPath: string;

  private socket: Socket;
  private buffer: Buffer;
  // ID CONTRACT (pinned): request ids are POSITIVE JSON INTEGERS, monotonic
  // per connection. String ids are coerced to -1 by the worker's engine-side
  // String->int conversion and every op would time out.
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private alive = true;
  private closeReason: string | null = null;
  private readonly token: string;
  private readonly maxFrameBytes: number;

  private constructor(
    socket: Socket,
    projectPath: string,
    token: string,
    initialBuffer: Buffer,
    maxFrameBytes: number
  ) {
    this.socket = socket;
    this.projectPath = projectPath;
    this.token = token;
    this.buffer = initialBuffer;
    this.maxFrameBytes = maxFrameBytes;

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) =>
      // error.message comes from the OS (ECONNRESET etc.); scrubbed anyway.
      this.failAll(
        `Headless worker connection error: ${this.scrub(error.message)}`
      )
    );
    socket.on("close", () => this.failAll("Headless worker connection closed."));
    // Process any bytes that arrived in the same chunk as the hello frame.
    if (this.buffer.length > 0) this.drainFrames();
  }

  static async connect(options: WorkerConnectOptions): Promise<WorkerConnection> {
    const host = options.host ?? "127.0.0.1";
    const connectTimeoutMs =
      options.connectTimeoutMs ?? envMs("SUMMER_WORKER_CONNECT_TIMEOUT_MS", 5_000);
    const helloTimeoutMs =
      options.helloTimeoutMs ?? envMs("SUMMER_WORKER_HELLO_TIMEOUT_MS", 3_000);

    const socket = await new Promise<Socket>((resolvePromise, rejectPromise) => {
      const sock = createConnection({ host, port: options.port });
      const timer = setTimeout(() => {
        sock.destroy();
        rejectPromise(
          new HeadlessTimeoutError(
            "connect",
            `Timed out after ${connectTimeoutMs}ms connecting to headless worker at ${host}:${options.port}.`
          )
        );
      }, connectTimeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        resolvePromise(sock);
      });
      sock.once("error", (error) => {
        clearTimeout(timer);
        rejectPromise(
          new HeadlessTimeoutError(
            "connect",
            `Could not connect to headless worker at ${host}:${options.port}: ${scrubSecrets(
              error.message,
              [options.token]
            )}`
          )
        );
      });
    });

    socket.setNoDelay(true);

    // --- v1.1 mutual auth. FIXED messages only in this phase: nothing
    // worker-supplied and no token material may reach an error string.
    const authFail = (reason: string): never => {
      socket.destroy();
      throw new HeadlessTimeoutError(
        "auth",
        `Headless worker handshake failed at ${host}:${options.port}: ${reason} ` +
          "(stale registry entry, pid reuse, or another process squatting the port)."
      );
    };

    const { line, rest } = await readFirstLine(socket, helloTimeoutMs);
    let hello: Record<string, unknown> | null = null;
    try {
      hello = asRecord(asRecord(JSON.parse(line))?.hello);
    } catch {
      hello = null;
    }
    const nonce = typeof hello?.nonce === "string" ? hello.nonce : null;
    const proof = typeof hello?.proof === "string" ? hello.proof : null;
    const pid = typeof hello?.pid === "number" ? hello.pid : null;
    if (!hello || nonce === null || proof === null || pid === null) {
      authFail("malformed hello");
    }
    if (!/^[0-9a-f]{32}$/.test(nonce as string)) {
      authFail("malformed hello nonce");
    }
    if ((proof as string).toLowerCase() !== helloProof(nonce as string, options.token)) {
      authFail("worker proof mismatch");
    }
    if (pid !== options.pid) {
      authFail("worker pid mismatch");
    }
    socket.write(
      JSON.stringify({ auth: clientAuthProof(nonce as string, options.token) }) + "\n"
    );

    const connection = new WorkerConnection(
      socket,
      options.projectPath,
      options.token,
      rest,
      options.maxFrameBytes ?? MAX_FRAME_BYTES
    );
    if (options.verifyWithPing !== false) {
      try {
        await connection.call("ping", {}, { timeoutMs: helloTimeoutMs });
      } catch {
        connection.close();
        // Fixed message — the ping failure detail could be worker-supplied.
        throw new HeadlessTimeoutError(
          "auth",
          `Headless worker at ${host}:${options.port} completed the handshake but did not answer ping ` +
            "(worker rejected the client auth or died during startup)."
        );
      }
    }
    return connection;
  }

  isAlive(): boolean {
    return this.alive;
  }

  call(
    op: string,
    params: Record<string, unknown> = {},
    options: CallOptions = {}
  ): Promise<unknown> {
    if (!this.alive) {
      return Promise.reject(
        new Error(
          this.closeReason ??
            "Headless worker connection is closed. Re-resolve the project connection and retry if safe."
        )
      );
    }
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? defaultOpTimeoutMs(op);

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const onTimeout = () => {
        this.pending.delete(id);
        if (MUTATING_OPS.has(op)) {
          // The mutation may or may not have applied — quarantine the whole
          // connection so nothing (including caller-side retries) can
          // silently reuse it and double-apply.
          rejectPromise(
            new HeadlessTimeoutError(
              "op",
              `Mutating worker op "${op}" produced no response or progress for ${timeoutMs}ms ` +
                `(request ${id}). The mutation's outcome is UNKNOWN. This connection has been ` +
                "quarantined (closed) to block blind retries; re-resolve and INSPECT the target " +
                "before retrying."
            )
          );
          this.failAll(
            "Headless worker connection quarantined: a mutating op timed out with unknown outcome."
          );
          this.socket.destroy();
          return;
        }
        rejectPromise(
          new HeadlessTimeoutError(
            "op",
            `Worker op "${op}" produced no response or progress for ${timeoutMs}ms ` +
              `(request ${id}). Its final state is unknown; inspect the target before retrying.`
          )
        );
      };
      const entry: PendingCall = {
        op,
        resolve: resolvePromise,
        reject: rejectPromise,
        onProgress: options.onProgress,
        timer: null,
        restartTimer: () => {
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = setTimeout(onTimeout, timeoutMs);
        },
      };
      this.pending.set(id, entry);
      // The inactivity timer starts only once the request has actually
      // FLUSHED to the socket — write backpressure must not eat the budget.
      this.socket.write(JSON.stringify({ id, op, params }) + "\n", (error) => {
        if (!this.pending.has(id)) return; // already settled (drop/response)
        if (error) {
          this.pending.delete(id);
          rejectPromise(
            new Error(
              `Headless worker request could not be sent: ${this.scrub(error.message)}. ` +
                "Nothing was submitted."
            )
          );
          return;
        }
        entry.restartTimer();
      });
    });
  }

  close(): void {
    this.failAll("Headless worker connection closed by client.");
    this.socket.destroy();
  }

  private scrub(text: string): string {
    return scrubSecrets(text, [this.token]);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drainFrames();
  }

  /** Byte-exact framing: split on 0x0a BEFORE utf-8 decoding, so a multibyte
   *  codepoint split across TCP chunks is reassembled correctly. */
  private drainFrames(): void {
    let newline: number;
    while ((newline = this.buffer.indexOf(NEWLINE)) >= 0) {
      const line = this.buffer.subarray(0, newline).toString("utf-8").trim();
      this.buffer = Buffer.from(this.buffer.subarray(newline + 1));
      if (!line) continue;
      let message: Record<string, unknown> | null;
      try {
        message = asRecord(JSON.parse(line));
      } catch {
        // A malformed line must not kill unrelated in-flight requests.
        continue;
      }
      if (!message) continue;
      this.dispatch(message);
    }
    if (this.buffer.length > this.maxFrameBytes) {
      this.failAll(
        `Headless worker sent an un-terminated frame larger than ${this.maxFrameBytes} bytes; ` +
          "closing the connection."
      );
      this.socket.destroy();
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id =
      typeof message.id === "number" && Number.isInteger(message.id)
        ? message.id
        : null;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;

    if (message.event === "progress") {
      // Liveness: progress restarts the inactivity timer, so a long op that
      // keeps reporting never times out spuriously.
      pending.restartTimer();
      try {
        pending.onProgress?.(message.progress);
      } catch {
        // A progress observer must never break the request itself.
      }
      return;
    }

    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message.result);
    } else {
      const error =
        typeof message.error === "string" && message.error.length > 0
          ? this.scrub(message.error)
          : "Headless worker reported an unspecified error.";
      // WorkerOpError carries a `.code` (sha256_mismatch / already_exists /
      // needs_display / ...) when the worker sent a structured classifier,
      // so guard failures are distinguishable from transport throws.
      pending.reject(new WorkerOpError(error));
    }
  }

  private failAll(reason: string): void {
    if (!this.alive) return;
    this.alive = false;
    this.closeReason = this.scrub(reason);
    const failures = [...this.pending.values()];
    this.pending.clear();
    for (const pending of failures) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        new Error(
          `${this.closeReason} The in-flight operation's final state is unknown; do not retry blindly.`
        )
      );
    }
  }
}
