import { readStoreJson, writeStoreJson } from "../store.js";

/**
 * The clients this computer uploaded to a Build whose server is a program
 * (~/.summer/build-clients.json), newest per platform. The store has no
 * route an agent sign-in can list a Build's clients with, so summer_go_live
 * reads which ones to release from here. It holds ids only: each client's
 * state is read from the store again before it is used, and uploading a file
 * the store already has records it here again without sending a byte.
 */

export const BUILD_CLIENTS_FILE = "build-clients.json";
/** Builds remembered; the oldest are forgotten first. */
const MAX_BUILDS = 200;

export interface RecordedClient {
  clientPackageId: string;
  clientVersion: string;
  sha256: string;
  recordedAt: string;
}

interface Stored {
  schemaVersion: 1;
  /** "<gameId>/<buildId>" -> platform -> the newest client uploaded from here. */
  builds: Record<string, Record<string, RecordedClient>>;
}

const keyOf = (gameId: string, buildId: string) => `${gameId}/${buildId}`;

async function read(): Promise<Stored> {
  const stored = await readStoreJson<Stored>(BUILD_CLIENTS_FILE).catch(() => null);
  return stored?.schemaVersion === 1 && stored.builds && typeof stored.builds === "object" ? stored : { schemaVersion: 1, builds: {} };
}

/** Remember the client this computer uploaded for one platform of a Build. */
export async function recordBuildClient(gameId: string, buildId: string, platform: string, client: RecordedClient): Promise<void> {
  const stored = await read();
  const key = keyOf(gameId, buildId);
  const { [key]: known, ...others } = stored.builds;
  // Written last, so the Builds touched most recently are the ones kept.
  const builds = { ...others, [key]: { ...known, [platform]: client } };
  const keep = Object.keys(builds).slice(-MAX_BUILDS);
  const next: Stored = { schemaVersion: 1, builds: Object.fromEntries(keep.map((name) => [name, builds[name]!])) };
  await writeStoreJson(BUILD_CLIENTS_FILE, next);
}

/** The clients this computer uploaded to a Build, by platform. */
export async function readBuildClients(gameId: string, buildId: string): Promise<Record<string, RecordedClient>> {
  return (await read()).builds[keyOf(gameId, buildId)] ?? {};
}
