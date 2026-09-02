import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { clientAuthProof, helloProof } from "../worker-connection.js";

/**
 * In-process fake headless worker for tests — protocol v1.1.
 *
 * On connect the fake worker sends
 *   {"hello":{"pid","nonce","proof": sha256(nonce + ':' + token)}}
 * then expects the client's {"auth": sha256('client:' + nonce + ':' + token)}
 * line, then answers {"id","op","params"} requests with
 * {"id","ok","result"|"error"} lines, with optional interim
 * {"id","event":"progress","progress"} lines. Knobs simulate a misbehaving
 * or hijacked worker (bad proof, wrong pid, silent hello).
 */

export type FakeOpHandler = (
  op: string,
  params: Record<string, unknown>,
  emit: {
    progress: (progress: unknown) => void;
    ok: (result: unknown) => void;
    error: (error: string) => void;
  },
  socket: Socket,
  id: number
) => void;

export interface FakeWorkerOptions {
  token: string;
  /** pid reported in hello. Default: process.pid. */
  pid?: number;
  /** Send a corrupted proof (simulates a squatter that lacks the token). */
  badProof?: boolean;
  /** Never send hello (client's hello timeout must fire). */
  noHello?: boolean;
  handler?: FakeOpHandler;
}

export interface FakeWorker {
  port: number;
  pid: number;
  requests: Array<{ id: number; op: string; params: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function startFakeWorker(
  options: FakeWorkerOptions
): Promise<FakeWorker> {
  const requests: FakeWorker["requests"] = [];
  const pid = options.pid ?? process.pid;
  const handler: FakeOpHandler =
    options.handler ??
    ((op, params, emit) => emit.ok({ echoed: true, op, params }));

  const server: Server = createServer((socket) => {
    let authed = false;
    let buffer = Buffer.alloc(0);
    const nonce = randomBytes(16).toString("hex"); // 32 hex chars

    if (!options.noHello) {
      const proof = options.badProof
        ? "0".repeat(64)
        : helloProof(nonce, options.token);
      socket.write(JSON.stringify({ hello: { pid, nonce, proof } }) + "\n");
    }

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let newline: number;
      while ((newline = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, newline).toString("utf-8").trim();
        buffer = Buffer.from(buffer.subarray(newline + 1));
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          socket.destroy();
          return;
        }
        if (!authed) {
          // First client line must be the auth proof (v1.1 mutual auth).
          if (message.auth !== clientAuthProof(nonce, options.token)) {
            socket.destroy();
            return;
          }
          authed = true;
          continue;
        }
        // ID CONTRACT (pinned): ids are positive JSON integers. The real
        // worker's engine-side String->int coercion would turn anything else
        // into -1 — the fake enforces the contract so every test proves it.
        if (
          typeof message.id !== "number" ||
          !Number.isInteger(message.id) ||
          message.id <= 0
        ) {
          socket.destroy();
          return;
        }
        const id = message.id;
        const op = String(message.op ?? "");
        const params = (message.params ?? {}) as Record<string, unknown>;
        requests.push({ id, op, params });
        handler(
          op,
          params,
          {
            progress: (progress) =>
              socket.write(
                JSON.stringify({ id, event: "progress", progress }) + "\n"
              ),
            ok: (result) =>
              socket.write(JSON.stringify({ id, ok: true, result }) + "\n"),
            error: (error) =>
              socket.write(JSON.stringify({ id, ok: false, error }) + "\n"),
          },
          socket,
          id
        );
      }
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake worker did not bind a port");
  }

  return {
    port: address.port,
    pid,
    requests,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
