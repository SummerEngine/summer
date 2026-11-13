import { appendStoreJsonLine, readStoreText } from "../store.js";

/**
 * The clients this computer uploaded to a Build whose server is a program
 * (~/.summer/build-clients.jsonl), newest per platform. The store has no
 * route an agent sign-in can list a Build's clients with, so summer_go_live
 * reads which ones to release from here. It holds ids only: each client's
 * state is read from the store again before it is used, and uploading a file
 * the store already has records it here again without sending a byte.
 *
 * One line per upload, appended, so the macOS, Windows and web clients can be
 * uploaded at the same time without one record replacing another.
 */

export const BUILD_CLIENTS_FILE = "build-clients.jsonl";

export interface RecordedClient {
  clientPackageId: string;
  clientVersion: string;
  sha256: string;
  recordedAt: string;
}

/** Remember the client this computer uploaded for one platform of a Build. */
export async function recordBuildClient(gameId: string, buildId: string, platform: string, client: RecordedClient): Promise<void> {
  await appendStoreJsonLine(BUILD_CLIENTS_FILE, { gameId, buildId, platform, ...client });
}

/** The clients this computer uploaded to a Build, by platform: the last one recorded for each. */
export async function readBuildClients(gameId: string, buildId: string): Promise<Record<string, RecordedClient>> {
  const clients: Record<string, RecordedClient> = {};
  for (const line of ((await readStoreText(BUILD_CLIENTS_FILE)) ?? "").split("\n")) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // an empty or cut-off line
    }
    if (!row || row.gameId !== gameId || row.buildId !== buildId || typeof row.platform !== "string" || typeof row.clientPackageId !== "string" || !row.clientPackageId) continue;
    clients[row.platform] = {
      clientPackageId: row.clientPackageId,
      clientVersion: typeof row.clientVersion === "string" ? row.clientVersion : "",
      sha256: typeof row.sha256 === "string" ? row.sha256 : "",
      recordedAt: typeof row.recordedAt === "string" ? row.recordedAt : "",
    };
  }
  return clients;
}
