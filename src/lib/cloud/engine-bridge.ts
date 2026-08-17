import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { EngineApiClient } from "../api-client.js";
import { checkEngineHealth, getApiPort, getApiToken } from "../engine.js";

/**
 * Engine coordination (spec 8.6.1 and 8.7). All calls degrade gracefully: an
 * unreachable engine never blocks a sync; the stability check and conflict
 * routing cover the gaps.
 */

/** sha256 hex of the stable .summer/local/.project_id (mirrors SummerEngineIdentity::project_id_hash). */
export async function readProjectIdHash(projectRoot: string): Promise<string | null> {
  try {
    const id = (await readFile(join(projectRoot, ".summer", "local", ".project_id"), "utf8")).trim();
    if (!id) return null;
    return createHash("sha256").update(id, "utf8").digest("hex");
  } catch {
    return null;
  }
}

export async function readProjectPathMarker(projectRoot: string): Promise<string | null> {
  try {
    const marker = (await readFile(join(projectRoot, ".summer", "local", ".project_path"), "utf8")).trim();
    return marker || null;
  } catch {
    return null;
  }
}

export async function writeProjectPathMarker(projectRoot: string): Promise<void> {
  const dir = join(projectRoot, ".summer", "local");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".project_path"), projectRoot, "utf8");
}

interface EngineSession {
  client: EngineApiClient;
  projectIdHash: string;
  scene?: string;
}

async function connectForProject(projectRoot: string): Promise<EngineSession | null> {
  const projectIdHash = await readProjectIdHash(projectRoot);
  if (!projectIdHash) return null;
  try {
    const port = await getApiPort();
    const token = await getApiToken();
    if (!token) return null;
    const health = await checkEngineHealth(port);
    if (!health) return null;
    // A different project's engine instance must never be asked to save or
    // rescan; the executor rejects mismatches too, but skip the round trip.
    if (health.projectIdHash && health.projectIdHash !== projectIdHash) return null;
    return {
      client: new EngineApiClient(port, token, {
        instanceId: health.instanceId,
        projectId: health.projectId,
        projectIdHash,
      }),
      projectIdHash,
      scene: health.scene,
    };
  } catch {
    return null;
  }
}

/**
 * Before hashing (spec 8.6.1): ask the running engine to flush dirty scenes
 * to disk so the walk hashes what the user actually sees.
 */
export async function saveDirtyScenesIfRunning(projectRoot: string): Promise<boolean> {
  const session = await connectForProject(projectRoot);
  if (!session) return false;
  try {
    await session.client.executeOps([{ op: "SaveDirtyScenes" }], { projectIdHash: session.projectIdHash });
    return true;
  } catch {
    return false;
  }
}

/**
 * After apply (spec 8.7): tell the open editor that files changed underneath it.
 *
 * BOTH HALVES OF THIS ARE CURRENTLY DEAD, and the user-visible symptom is that
 * after a cloud pull the editor keeps showing the pre-pull bytes:
 *
 *  - `ScanChanges` is not an engine op. The dispatch ladder
 *    (modules/1summer_engine/editor/ops_executor.cpp:1060-1290) has 84 op kinds and
 *    no ScanChanges branch, so this fails on EVERY build, not just older ones. The
 *    engine-side capability exists as EditorFileSystem::scan_changes() but is
 *    exposed neither as an op nor to GDScript, so there is no caller-reachable
 *    rescan verb at all. O2 owns adding one.
 *  - The scene reload depends on `session.scene`, which /api/health never returns
 *    (see the note in lib/engine.ts), so it is always undefined and never fires.
 *
 * Until the engine exposes a rescan, say so out loud rather than swallowing it —
 * a stale editor that looks correct is exactly the failure this codebase is trying
 * to stop shipping.
 */
export async function notifyEngineAfterApply(projectRoot: string, appliedPaths: readonly string[]): Promise<void> {
  if (!appliedPaths.length) return;
  const session = await connectForProject(projectRoot);
  if (!session) return;

  let rescanned = false;
  try {
    await session.client.executeOps([{ op: "ScanChanges" }], { projectIdHash: session.projectIdHash });
    rescanned = true;
  } catch {
    rescanned = false;
  }

  let reloaded = false;
  try {
    const scene = session.scene;
    if (scene && scene.startsWith("res://")) {
      const sceneRel = scene.slice("res://".length);
      if (appliedPaths.includes(sceneRel)) {
        await session.client.executeOps([{ op: "OpenScene", path: scene }], { projectIdHash: session.projectIdHash });
        reloaded = true;
      }
    }
  } catch {
    reloaded = false;
  }

  if (!rescanned) {
    console.warn(
      `Pulled ${appliedPaths.length} file(s), but could not tell the running editor to rescan ` +
        "(this engine build exposes no rescan op). The editor may still be showing the old " +
        "contents — click into its window, or reopen the affected scene, before trusting what you see."
    );
  } else if (!reloaded) {
    console.warn(
      "Pulled files and rescanned, but could not confirm which scene is open, so an open " +
        "scene replaced by the pull was not reloaded. Reopen it before trusting what you see."
    );
  }
}
