/**
 * connect-signal — ONE implementation of `summer_connect_signal` for both faces
 * (src/mcp/tools/scene-tools.ts and tool-dispatch.ts) that leaves the
 * connection in the saved scene, verified from the file.
 *
 * Why not the engine's ConnectSignal op: it builds
 * `Callable(receiver, method)` and registers
 * `add_do_method(emitter, "connect", signal, cb)` — no CONNECT_PERSIST, and the
 * op reads no flags argument. PackedScene::pack writes only persistent
 * connections, so the receipt said ok, the batch said persisted:true, and the
 * saved .tscn had no [connection] line (engine 0.6.0, a Clock.timeout ->
 * Door.queue_free connection). The editor's own Node dock connects with
 * CONNECT_PERSIST; so does this tool:
 *   0. SaveScene (opens the scene as a tab if needed; the file is the editor
 *      state), read the file: an identical [connection] line already there is
 *      reported as done, nothing else sent;
 *   1. RunSceneScript runs against the ACTIVE tab, so a target scene in a
 *      background tab is brought forward with OpenScene first (and the user's
 *      tab restored at the end);
 *   2. a RunSceneScript probe: `emitter.connect(signal, Callable(receiver,
 *      method), CONNECT_PERSIST)` — an existing non-persistent connection of
 *      the same pair (an earlier ConnectSignal) is replaced by a persistent one;
 *   3. SaveScene — the run marked the tab unsaved; this leaves it clean;
 *   4. verify the saved local declaration or the matching edge in the saved
 *      instance/base scene graph for an already-connected pair.
 */
import { z } from "zod";
import { missingEngineOpResult, resolveSingleOnlyOps, type CapabilityAdvertisingClient } from "../capability-skew.js";
import { ToolInputError } from "../tool-errors.js";
import { asRecord, stringFrom, type JsonRecord } from "../util/json.js";
import { executeOpsChunked, safeProjectPath } from "./engine-ops.js";
import { extractOpError } from "./engine-receipt.js";
import { buildRunSceneScriptOp } from "./scene-script.js";
import { isReadbackFailure, readSavedScene, readbackFailure } from "./scene-readback.js";
import { normalizeNodePath, type ParsedTscn, type TscnConnection } from "./tscn.js";

// Mirrors library/tools/connect-signal/resource.yaml input_schema (parity-tested).
export const connectSignalInputShape = {
  scenePath: z.string().describe("Target scene path, e.g. 'res://main.tscn'"),
  emitter: z.string().describe("Node that fires the signal, e.g. './Player/HitArea'"),
  signal: z.string().describe("Signal name, e.g. 'body_entered'"),
  receiver: z.string().describe("Node with the handler script, e.g. './Player'"),
  method: z.string().describe("Method name in the receiver's script, e.g. '_on_hit_area_body_entered'"),
};

export const connectSignalInputSchema = z.object(connectSignalInputShape).strict();
export type ConnectSignalArgs = z.infer<typeof connectSignalInputSchema>;

export interface ConnectSignalClient extends CapabilityAdvertisingClient {
  executeIdentityBoundOps(
    ops: Record<string, unknown>[],
    options?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<unknown>;
  readProjectFile(path: string, maxBytes?: number): Promise<unknown>;
  getSceneState(
    scenePath?: string,
    options?: { depth?: number; limit?: number; root?: string }
  ): Promise<unknown>;
}

export const CONNECT_SIGNAL_FALLBACK =
  "connect it from summer_run_script with emitter.connect(signal, Callable(receiver, method), CONNECT_PERSIST) or ctx.connect_signal, then summer_save_scene, and confirm the [connection] line with summer_read_file";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The probe. Values are embedded as JSON string literals, which GDScript
 *  reads with the same escapes. Returns a Dictionary (RunSceneScript's
 *  `result`); expected failures return ok:false instead of raising, so the
 *  engine has nothing to roll back. */
export function connectScript(target: string, emitter: string, signal: string, receiver: string, method: string): string {
  const lit = (value: string) => JSON.stringify(value);
  return `const TARGET_SCENE := ${lit(target)}
const EMITTER := ${lit(emitter)}
const SIGNAL_NAME := ${lit(signal)}
const RECEIVER := ${lit(receiver)}
const METHOD := ${lit(method)}

func _resolve(root: Node, path: String) -> Node:
	if path == "" or path == "." or path == "./" or path == "/":
		return root
	var node := root.get_node_or_null(NodePath(path))
	if node == null or (node != root and not root.is_ancestor_of(node)):
		return null
	return node

func _flags(emitter: Node, callable: Callable) -> int:
	for c in emitter.get_signal_connection_list(SIGNAL_NAME):
		if c["callable"] == callable:
			return int(c["flags"])
	return -1

# Read packed declarations without running constructors or adding nodes to the tree.
func _relative_to_instance(path: String, instance: String) -> String:
	if path == instance:
		return "."
	if path.begins_with(instance + "/"):
		return path.trim_prefix(instance + "/")
	return ""

func _declaring_scene(state: SceneState, source_path: String, target_path: String) -> Dictionary:
	while state != null:
		for i in state.get_connection_count():
			if state.get_connection_signal(i) != SIGNAL_NAME or state.get_connection_method(i) != METHOD:
				continue
			if String(state.get_connection_source(i)).trim_prefix("./") != source_path or String(state.get_connection_target(i)).trim_prefix("./") != target_path:
				continue
			if state.get_connection_unbinds(i) == 0 and state.get_connection_binds(i).is_empty():
				return {"scene": state.get_path(), "flags": state.get_connection_flags(i)}
		for i in range(1, state.get_node_count()):
			var instance := state.get_node_instance(i)
			if instance == null:
				continue
			var path := String(state.get_node_path(i)).trim_prefix("./")
			var from := _relative_to_instance(source_path, path)
			var to := _relative_to_instance(target_path, path)
			if from != "" and to != "":
				var saved := _declaring_scene(instance.get_state(), from, to)
				if not saved.is_empty():
					return saved
		state = state.get_base_scene_state()
	return {}

func run(ctx):
	var root: Node = ctx.get_scene_root()
	if root == null:
		return {"ok": false, "failure_reason": "no_edited_scene", "error": "No scene is open in the editor."}
	if root.scene_file_path != TARGET_SCENE:
		return {"ok": false, "failure_reason": "scene_not_active", "active_scene": root.scene_file_path, "error": "The active editor tab is " + root.scene_file_path + ", not " + TARGET_SCENE + "; nothing was connected."}
	var emitter := _resolve(root, EMITTER)
	if emitter == null:
		return {"ok": false, "failure_reason": "emitter_not_found", "error": "Emitter not found: " + EMITTER}
	var receiver := _resolve(root, RECEIVER)
	if receiver == null:
		return {"ok": false, "failure_reason": "receiver_not_found", "error": "Receiver not found: " + RECEIVER}
	if not emitter.has_signal(SIGNAL_NAME):
		var names := []
		for s in emitter.get_signal_list():
			names.append(String(s["name"]))
		return {"ok": false, "failure_reason": "signal_not_found", "signals": names, "error": emitter.get_class() + " " + EMITTER + " has no signal " + SIGNAL_NAME}
	var callable := Callable(receiver, METHOD)
	var before := _flags(emitter, callable)
	var previous := "none"
	if before >= 0:
		previous = "persistent" if (before & Object.CONNECT_PERSIST) != 0 else "not_persistent"
	if previous == "not_persistent":
		emitter.disconnect(SIGNAL_NAME, callable)
	if previous != "persistent":
		var err: int = emitter.connect(SIGNAL_NAME, callable, Object.CONNECT_PERSIST)
		if err != OK:
			return {"ok": false, "failure_reason": "connect_failed", "error": "connect() returned error " + str(err)}
	var flags := _flags(emitter, callable)
	if flags < 0 or (flags & Object.CONNECT_PERSIST) == 0:
		return {"ok": false, "failure_reason": "connect_failed", "flags": flags, "error": "The connection is not persistent after connect() (flags " + str(flags) + ")."}
	var source_path := str(root.get_path_to(emitter))
	var target_path := str(root.get_path_to(receiver))
	var result := {"ok": true, "previous": previous, "flags": flags, "from": source_path, "to": target_path, "method_exists": receiver.has_method(METHOD)}
	if previous == "persistent":
		var packed := ResourceLoader.load(TARGET_SCENE, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE_DEEP) as PackedScene
		if packed != null:
			result.declaration = _declaring_scene(packed.get_state(), source_path, target_path)
	return result
`;
}

/** The [connection] line for signal/from/to/method in the parsed scene. */
export function findConnection(
  parsed: ParsedTscn,
  wanted: { signal: string; from: string; to: string; method: string }
): TscnConnection | undefined {
  const from = normalizeNodePath(wanted.from);
  const to = normalizeNodePath(wanted.to);
  return parsed.connections.find(
    (c) => c.signal === wanted.signal && c.method === wanted.method && c.from === from && c.to === to
  );
}

/** The scene in the active editor tab, from the published scene state. */
async function activeScenePath(client: ConnectSignalClient): Promise<string | null> {
  try {
    const state = asRecord(await client.getSceneState());
    return (
      stringFrom(asRecord(state?.provenance)?.scenePath) ??
      stringFrom(asRecord(state?.data)?.scenePath) ??
      null
    );
  } catch {
    return null;
  }
}

/** The RunSceneScript entry of a receipt (its `result` is the probe's Dictionary). */
function scriptEntry(receipt: unknown): JsonRecord | null {
  const envelope = asRecord(receipt);
  const results = Array.isArray(envelope?.results) ? envelope!.results : [];
  const entry = results.map((r) => asRecord(r)).find((r) => r?.op === "RunSceneScript") ?? asRecord(results[0]);
  return entry ?? envelope;
}

/**
 * Connect `signal` of `emitter` to `method` of `receiver` in `scenePath` so the
 * saved scene holds it, and prove that from the file.
 */
export async function connectSignalPersisted(client: ConnectSignalClient, args: ConnectSignalArgs): Promise<JsonRecord> {
  const scenePath = safeProjectPath(args.scenePath);
  if (!scenePath.endsWith(".tscn")) {
    throw new ToolInputError(
      "summer_connect_signal verifies the connection in the saved text scene, so scenePath must be a .tscn file. For a binary .scn: " +
        CONNECT_SIGNAL_FALLBACK + "."
    );
  }
  const signal = args.signal.trim();
  const method = args.method.trim();
  const emitter = args.emitter.trim();
  const receiver = args.receiver.trim();
  if (!IDENTIFIER.test(signal)) throw new ToolInputError(`Invalid signal "${args.signal}": pass a signal name such as 'body_entered'.`);
  if (!IDENTIFIER.test(method)) throw new ToolInputError(`Invalid method "${args.method}": pass a method name such as '_on_timer_timeout'.`);
  for (const [label, value] of [["emitter", emitter], ["receiver", receiver]] as const) {
    if (value === "" || /[\u0000-\u001f"]/.test(value)) {
      throw new ToolInputError(`Invalid ${label} path "${value}": pass a scene-relative node path such as './World/Door' ('.' is the scene root).`);
    }
  }
  const wanted = { signal, from: emitter, to: receiver, method };
  const describe = `${normalizeNodePath(emitter)}:${signal} -> ${normalizeNodePath(receiver)}:${method}`;

  for (const op of ["RunSceneScript", "SaveScene"]) {
    const missing = missingEngineOpResult(client, op, CONNECT_SIGNAL_FALLBACK);
    if (missing) return { ...missing };
  }
  const singleOnly = resolveSingleOnlyOps(client);
  const save = () =>
    executeOpsChunked((chunk) => client.executeIdentityBoundOps(chunk, { scenePath }), [{ op: "SaveScene" }], singleOnly);

  // 0. Save (the file is the editor state; the scene is open as a tab), read.
  const pre = await save();
  if (extractOpError(pre)) {
    return { ...(asRecord(pre) ?? {}), note: `Nothing was connected: SaveScene on ${scenePath} failed before the connection.` };
  }
  const before = await readSavedScene(client, scenePath, `Connect it by hand: ${CONNECT_SIGNAL_FALLBACK}.`);
  if (isReadbackFailure(before)) return { ...before, note: "Nothing was connected." };
  const existing = findConnection(before.parsed, wanted);
  if (existing) {
    return {
      ok: true,
      persisted: true,
      verified: true,
      already_connected: true,
      scenePath,
      connection: { signal, from: existing.from, to: existing.to, method },
      line: existing.raw,
      note: `The saved ${scenePath} already holds this connection; nothing was changed.`,
    };
  }

  // 1. The probe runs in the active tab: bring the target forward if needed.
  const warnings: string[] = [];
  const active = await activeScenePath(client);
  let restoreTo: string | null = null;
  if (active !== scenePath) {
    const opened = await client.executeIdentityBoundOps([{ op: "OpenScene", path: scenePath }]);
    const openError = extractOpError(opened);
    if (openError) {
      return readbackFailure(
        "scene_activation_failed",
        `Nothing was connected: the probe runs in the active editor tab and ${scenePath} could not be brought forward (${openError}).`,
        { persisted: false, verified: false }
      );
    }
    restoreTo = active;
    if (!active) warnings.push(`The active tab could not be read, so ${scenePath} was brought forward and left open as the active tab.`);
  }
  const restoreTab = async () => {
    if (!restoreTo) return;
    const back = await client.executeIdentityBoundOps([{ op: "OpenScene", path: restoreTo }]);
    if (extractOpError(back)) warnings.push(`${scenePath} was brought forward for the probe; switching back to ${restoreTo} failed.`);
  };
  const tabNote = restoreTo ? { tab_switched: { to: scenePath, restored: restoreTo } } : {};

  // 2. Connect with CONNECT_PERSIST.
  const { op, timeoutMs } = buildRunSceneScriptOp({
    source: connectScript(scenePath, emitter, signal, receiver, method),
    max_seconds: 10,
    checkpoint: false,
  });
  const ran = await client.executeIdentityBoundOps([op], undefined, timeoutMs);
  const runError = extractOpError(ran);
  const outcome = asRecord(scriptEntry(ran)?.result);
  if (runError || !outcome) {
    await restoreTab();
    return readbackFailure(
      "connect_failed",
      `Nothing was connected: the RunSceneScript probe failed (${runError ?? "no result from the probe"}). ${scenePath} on disk is unchanged.`,
      { persisted: false, verified: false, ...tabNote, ...(warnings.length ? { warnings } : {}) }
    );
  }
  if (outcome.ok !== true) {
    // The run marked the active tab unsaved; it was saved a moment ago, so a
    // save of the target (when it is the one the probe ran in) leaves it clean.
    if (outcome.failure_reason !== "scene_not_active") await save();
    await restoreTab();
    return readbackFailure(
      String(outcome.failure_reason ?? "connect_failed"),
      `Nothing was connected (${describe}): ${String(outcome.error ?? "the probe refused")}` +
        (outcome.failure_reason === "scene_not_active"
          ? " The engine marks the tab a script ran in as unsaved; that tab's content is unchanged."
          : ""),
      {
        persisted: false,
        verified: false,
        ...(Array.isArray(outcome.signals) ? { signals: outcome.signals } : {}),
        ...tabNote,
        ...(warnings.length ? { warnings } : {}),
      }
    );
  }

  // 3. Save: the run marked the tab unsaved.
  const saved = await save();
  await restoreTab();
  const from = normalizeNodePath(String(outcome.from ?? emitter));
  const to = normalizeNodePath(String(outcome.to ?? receiver));
  if (extractOpError(saved)) {
    return {
      ...(asRecord(saved) ?? {}),
      ok: false,
      persisted: false,
      verified: false,
      note: `${describe} is connected in the editor (persistent), but SaveScene failed, so ${scenePath} on disk does not hold it. Fix the save error, then call summer_save_scene.`,
    };
  }

  // 4. Read the file back.
  const after = await readSavedScene(client, scenePath);
  if (isReadbackFailure(after)) {
    return { ...after, persisted: false, verified: false, note: "The connection was made and saved, but the file could not be read back to verify it." };
  }
  const line = findConnection(after.parsed, { signal, from, to, method });
  const persistence = asRecord(asRecord(saved)?.scenePersistence);
  // SaveScene's meta.dirty is the tab's unsaved flag right after the save.
  const savedResults = asRecord(saved)?.results;
  const saveMeta = asRecord(
    (Array.isArray(savedResults) ? savedResults.map((r) => asRecord(r)) : []).find((r) => r?.op === "SaveScene")?.meta
  );
  const tabClean = typeof saveMeta?.dirty === "boolean" ? { tab_clean: !saveMeta.dirty } : {};
  // The probe never changes an existing persistent callable. Its fresh PackedScene
  // read is evidence for an inherited edge if the saved root still matches.
  const declaration = asRecord(outcome.declaration);
  const inherited = !line && outcome.previous === "persistent" && typeof declaration?.scene === "string" &&
    declaration.scene !== "" && declaration.scene !== scenePath ? declaration : null;
  if (inherited && before.sha256 !== after.sha256) {
    return readbackFailure(
      "scene_verification_changed",
      `Could not confirm that ${scenePath} still matches the scene Godot checked for the inherited connection. Run summer_connect_signal again to verify the saved scene.`,
      { verified: false, ...tabNote }
    );
  }
  if (!line && !inherited) {
    return readbackFailure(
      "not_persisted",
      `summer_connect_signal did NOT persist (persisted:false): the saved ${scenePath} has no [connection signal="${signal}" from="${from}" to="${to}" method="${method}"] line ` +
        `although the editor reports the connection with flags ${String(outcome.flags)}. Do not report it as done: read the saved file (summer_read_file) and ${CONNECT_SIGNAL_FALLBACK}.`,
      { persisted: false, verified: false, ...tabNote }
    );
  }
  if (outcome.method_exists === false) {
    warnings.push(
      `${to} has no method ${method} yet: the connection is saved, but the signal raises an error when it fires until the receiver's script defines it.`
    );
  }
  return {
    ok: true,
    persisted: true,
    verified: true,
    scenePath,
    connection: { signal, from, to, method },
    ...(line ? { line: line.raw } : { already_connected: true, declaration: inherited }),
    ...(outcome.previous === "not_persistent" ? { replaced_non_persistent: true } : {}),
    via: inherited ? "Godot SceneState read from the saved scene and its dependencies" : "RunSceneScript: emitter.connect(signal, Callable(receiver, method), CONNECT_PERSIST), then SaveScene",
    ...(persistence ? { scenePersistence: { ...persistence, verified: true } } : {}),
    ...tabClean,
    ...tabNote,
    ...(warnings.length ? { warnings } : {}),
    ...(inherited ? {} : { undo: "One Ctrl+Z in that scene reverts the connection (the scene script's undo step)." }),
  };
}
