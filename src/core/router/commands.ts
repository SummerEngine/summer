import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { RouterApiError, seg, type RouterApi } from "./api.js";
import { handlerSnippet, scanToolHandlers, unhandledClientTools, type HandlerMap } from "./handlers.js";
import { apiFailure, failure, success, type RouterAnswer, type RouterFailure } from "./result.js";
import {
  CHARACTER_ID,
  CHARACTERS_DIR,
  characterPath,
  documentHash,
  findProjectRoot,
  readCharacterFiles,
  readRouterState,
  resolveGameId,
  writeCharacterFile,
  writeRouterState,
  type CharacterFile,
} from "./project.js";
import { loadRegistry, validateCharacter, type RouterRegistry } from "./registry.js";
import { studioGamesUrl, studioRouterUrl } from "./studio.js";
import { buildCharacter, TEMPLATES, TOOL_NAME, type TemplateId } from "./templates.js";

/**
 * The Summer Router local operations: the ones that need the game project on
 * this machine (its ai/characters files and its GDScript). The cloud ones
 * (test turns, settings and caps, usage, the catalog) run on the hosted
 * Summer server.
 *
 *   router.add_character  write ai/characters/<id>.json from a template
 *   router.check          schema + GDScript tool handlers, offline, no sign-in
 *   router.push           check, then save the characters on Summer for the game
 *   router.pull           write Summer's characters into ai/characters/
 */

/** Everything an operation touches outside its input (fakes in tests). */
export interface RouterContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  api: RouterApi;
  gateway: () => Promise<string>;
  /** input.project */
  project?: string;
  /** input.gameId */
  game?: string;
}

interface StoredCharacter {
  character_id: string;
  version: number;
  config: Record<string, unknown>;
  deleted?: boolean;
}

const NOT_SERVED = "This Summer does not serve this Summer Router route yet. Update summer-engine, or retry after the platform release.";

function projectRoot(ctx: RouterContext): string | null {
  return findProjectRoot(ctx.project ? resolve(ctx.cwd, ctx.project) : ctx.cwd);
}

function noProject(ctx: RouterContext): RouterFailure {
  return failure(
    "not_a_project",
    `No project.godot at or above ${ctx.project ? resolve(ctx.cwd, ctx.project) : ctx.cwd}.`,
    "Run it inside the Summer project, or pass project with the folder that holds project.godot."
  );
}

async function requireGame(ctx: RouterContext, root: string | null): Promise<{ gameId: string } | RouterFailure> {
  const { gameId } = resolveGameId(root, ctx.game, ctx.env);
  if (gameId) return { gameId };
  return failure(
    "game_id_missing",
    "No game id: Summer Router settings belong to one game on Summer.",
    "Pass gameId, set SUMMER_GAME_ID, or add gameId to summer.build.json. Studio lists your games and their ids.",
    { studio_url: studioGamesUrl(await ctx.gateway()) }
  );
}

const isFailed = (value: unknown): value is RouterFailure =>
  Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false);

/** A missing route answers 404 without a message (the store proxy) or with plain text (the platform mux). */
function isRouteMissing(error: unknown): boolean {
  return error instanceof RouterApiError && error.status === 404 && /^Summer refused the request/.test(error.message);
}

// ---------------------------------------------------------------- router.add_character

export interface AddCharacterInput {
  id: string;
  template?: string;
  name?: string;
  voice?: string;
  voiceId?: string;
  tools?: string[];
  force?: boolean;
}

export async function addCharacter(ctx: RouterContext, input: AddCharacterInput): Promise<RouterAnswer> {
  if (!CHARACTER_ID.test(input.id ?? "")) {
    return failure("invalid_input", `"${input.id}" is not a character id.`, "Use a lowercase letter first, then lowercase letters, digits, _ or -, at most 64 characters (for example guard).");
  }
  const template = (input.template ?? "voice-npc") as TemplateId;
  if (!TEMPLATES.includes(template)) {
    return failure("invalid_input", `Unknown template "${input.template}".`, `Use one of: ${TEMPLATES.join(", ")}.`);
  }
  const tools = [...new Set((input.tools ?? []).map((tool) => tool.trim()).filter(Boolean))];
  const badTool = tools.find((tool) => !TOOL_NAME.test(tool));
  if (badTool) {
    return failure("invalid_input", `"${badTool}" is not a tool name.`, "Use a letter or _ first, then letters, digits or _, at most 64 characters (for example open_gate).");
  }
  if (input.voice && input.voiceId) {
    return failure("invalid_input", "voice and voiceId are both set.", "Pass a voice description in voice, or a Summer voice id in voiceId, not both.");
  }
  const root = projectRoot(ctx);
  if (!root) return noProject(ctx);
  const path = characterPath(root, input.id);
  if (existsSync(path) && !input.force) {
    return failure("character_exists", `${CHARACTERS_DIR}/${input.id}.json already exists.`, "Edit that file, or pass force to replace it with the template.");
  }

  const doc = buildCharacter({ id: input.id, template, name: input.name, voice: input.voice, voiceId: input.voiceId, tools });
  const { registry } = await loadRegistry(null);
  const issues = validateCharacter(doc, registry);
  if (issues.length > 0) {
    return failure("invalid_character", "The new character does not match the registry schema.", "Shorten the name or voice description and retry.", { details: issues });
  }
  writeCharacterFile(root, doc);

  const unhandled = unhandledClientTools([{ id: input.id, doc }], scanToolHandlers(root));
  return success({
    character: input.id,
    path: `${CHARACTERS_DIR}/${input.id}.json`,
    template,
    document: doc,
    unhandled_tools: unhandled.map((t) => t.tool),
    ...(unhandled.length ? { handler_snippet: handlerSnippet(unhandled) } : {}),
    next_steps: [
      ...(unhandled.length ? [`Add a GDScript handler for each client tool (${unhandled.map((t) => t.tool).join(", ")}): see handler_snippet.`] : []),
      `Edit ${CHARACTERS_DIR}/${input.id}.json: instructions, tool descriptions and parameters.`,
      "router.check, then router.push",
      `router.test with characterId "${input.id}"`,
    ],
  });
}

// ---------------------------------------------------------------- router.check

interface LocalCheck {
  files: CharacterFile[];
  registry: RouterRegistry;
  registrySource: string;
  handlers: HandlerMap;
}

async function checkLocal(ctx: RouterContext, root: string, ids: string[] | undefined, live: boolean): Promise<LocalCheck | RouterFailure> {
  const all = readCharacterFiles(root);
  const missing = (ids ?? []).filter((id) => !all.some((file) => file.id === id));
  if (missing.length) {
    return failure("character_not_found", `No ${missing.map((id) => `${CHARACTERS_DIR}/${id}.json`).join(", ")}.`, `Create it with router.add_character (id "${missing[0]}").`);
  }
  const files = ids?.length ? all.filter((file) => ids.includes(file.id)) : all;
  if (files.length === 0) {
    return failure("no_characters", `No characters in ${CHARACTERS_DIR}/.`, 'Create one with router.add_character, for example id "guard", template "voice-npc", tools ["open_gate"].');
  }
  const { registry, source } = await loadRegistry(live ? () => ctx.api.request("GET", "router/registry") : null);
  const invalid: Array<{ character: string; path: string; message: string }> = [];
  for (const file of files) {
    if (file.error) {
      invalid.push({ character: file.id, path: "", message: `${CHARACTERS_DIR}/${file.id}.json ${file.error}` });
      continue;
    }
    for (const issue of validateCharacter(file.doc, registry)) invalid.push({ character: file.id, path: issue.path, message: issue.message });
  }
  if (invalid.length) {
    return failure(
      "invalid_character",
      `${invalid.length} problem${invalid.length === 1 ? "" : "s"} in ${CHARACTERS_DIR}/: ${invalid
        .slice(0, 5)
        .map((issue) => `${issue.character}${issue.path} ${issue.message}`)
        .join("; ")}.`,
      "Fix each field listed in details, then run router.check again.",
      { details: invalid }
    );
  }
  const handlers = scanToolHandlers(root);
  const unhandled = unhandledClientTools(files, handlers);
  if (unhandled.length) {
    return failure(
      "tool_unhandled",
      `No GDScript handler for ${unhandled.map((t) => `${t.character}.${t.tool}`).join(", ")}. The character could call it and nothing in the game would answer.`,
      "Register each tool on the character or session (shape in details.handler_snippet), then check again.",
      { docs_url: "https://docs.summerengine.com/router/gdscript#tools", details: { unhandled, handler_snippet: handlerSnippet(unhandled) } }
    );
  }
  return { files, registry, registrySource: source, handlers };
}

function clientTools(file: CharacterFile, handlers: HandlerMap): Array<{ name: string; handled_in: string[] }> {
  const tools = Array.isArray(file.doc?.tools) ? (file.doc!.tools as Array<Record<string, unknown>>) : [];
  return tools
    .filter((tool) => (tool.runs_on ?? "client") === "client" && typeof tool.name === "string")
    .map((tool) => ({ name: tool.name as string, handled_in: (handlers.get(tool.name as string) ?? []).map((site) => `${site.file}:${site.line}`) }));
}

export interface CharactersInput {
  characters?: string[];
}

export async function check(ctx: RouterContext, input: CharactersInput): Promise<RouterAnswer> {
  const root = projectRoot(ctx);
  if (!root) return noProject(ctx);
  const checked = await checkLocal(ctx, root, input.characters, false);
  if (isFailed(checked)) return checked;
  return success({
    valid: true,
    registry_source: checked.registrySource,
    characters: checked.files.map((file) => ({ id: file.id, client_tools: clientTools(file, checked.handlers) })),
    next_steps: ["router.push"],
  });
}

// ---------------------------------------------------------------- router.push

export interface PushInput extends CharactersInput {
  force?: boolean;
}

export async function push(ctx: RouterContext, input: PushInput): Promise<RouterAnswer> {
  const root = projectRoot(ctx);
  if (!root) return noProject(ctx);
  const checked = await checkLocal(ctx, root, input.characters, true);
  if (isFailed(checked)) return checked;
  const { files, handlers } = checked;
  const game = await requireGame(ctx, root);
  if (isFailed(game)) return game;
  const studio = studioRouterUrl(await ctx.gateway(), game.gameId);
  const state = readRouterState(root);
  const pushed: Array<{ id: string; version: number; action: "created" | "updated" | "unchanged" }> = [];
  const conflicts: Array<{ id: string; summer_version: number; base_version: number | null }> = [];
  const base = `games/${seg(game.gameId)}/router/characters`;

  try {
    for (const file of files) {
      const doc = file.doc!;
      const hash = documentHash(doc);
      let remote: StoredCharacter | null = null;
      try {
        remote = await ctx.api.request<StoredCharacter>("GET", `${base}/${seg(file.id)}`);
      } catch (error) {
        if (!(error instanceof RouterApiError && error.status === 404 && !isRouteMissing(error))) throw error;
      }
      if (remote && documentHash(remote.config) === hash && !remote.deleted) {
        state.characters[file.id] = { version: remote.version, hash };
        pushed.push({ id: file.id, version: remote.version, action: "unchanged" });
        continue;
      }
      const known = state.characters[file.id];
      if (remote && !remote.deleted && !input.force && known?.version !== remote.version) {
        conflicts.push({ id: file.id, summer_version: remote.version, base_version: known?.version ?? null });
        continue;
      }
      const saved = await ctx.api.request<StoredCharacter>("PUT", `${base}/${seg(file.id)}`, {
        body: doc,
        query: { expected_version: remote ? remote.version : 0 },
      });
      state.characters[file.id] = { version: saved.version, hash };
      pushed.push({ id: file.id, version: saved.version, action: remote && !remote.deleted ? "updated" : "created" });
    }
  } catch (error) {
    writeRouterState(root, state);
    return apiFailure(error, {
      registry: checked.registry,
      studioUrl: studio,
      notFound: isRouteMissing(error) ? NOT_SERVED : `Summer has no game ${game.gameId} for this account. Check the game id (summer.build.json gameId).`,
    });
  }
  writeRouterState(root, state);

  if (conflicts.length) {
    return failure(
      "studio_changed",
      `Summer has a newer version of ${conflicts.map((c) => c.id).join(", ")} than this project last saw (edited in Studio or by someone else). Not pushed, so nothing was overwritten.`,
      `Run router.pull for ${conflicts.map((c) => c.id).join(", ")} to take Summer's version, or router.push with force to replace it with yours.`,
      { studio_url: studio, details: { conflicts, pushed } }
    );
  }
  const first = files[0].id;
  const firstTool = clientTools(files[0], handlers)[0]?.name;
  return success({
    game_id: game.gameId,
    pushed,
    studio_url: studio,
    next_steps: [`router.test with gameId "${game.gameId}", characterId "${first}"${firstTool ? `, and check that it calls ${firstTool}` : ""}`],
  });
}

// ---------------------------------------------------------------- router.pull

export interface PullInput extends CharactersInput {
  force?: boolean;
}

export async function pull(ctx: RouterContext, input: PullInput): Promise<RouterAnswer> {
  const root = projectRoot(ctx);
  if (!root) return noProject(ctx);
  const game = await requireGame(ctx, root);
  if (isFailed(game)) return game;
  let list: StoredCharacter[];
  try {
    const answer = await ctx.api.request<{ characters?: StoredCharacter[] }>("GET", `games/${seg(game.gameId)}/router/characters`);
    list = (answer.characters ?? []).filter((character) => !character.deleted);
  } catch (error) {
    return apiFailure(error, { notFound: isRouteMissing(error) ? NOT_SERVED : `Summer has no game ${game.gameId} for this account.` });
  }
  if (input.characters?.length) {
    const missing = input.characters.filter((id) => !list.some((character) => character.character_id === id));
    if (missing.length) {
      return failure("character_not_found", `Summer has no character ${missing.join(", ")} for game ${game.gameId}.`, "Run router.pull without characters to see what Summer has.");
    }
    list = list.filter((character) => input.characters!.includes(character.character_id));
  }

  const state = readRouterState(root);
  const local = new Map(readCharacterFiles(root).map((file) => [file.id, file]));
  const pulled: Array<{ id: string; version: number; action: "written" | "unchanged" | "kept_local" }> = [];
  for (const remote of list) {
    const id = remote.character_id;
    const hash = documentHash(remote.config);
    const file = local.get(id);
    const localHash = file?.doc ? documentHash(file.doc) : null;
    if (localHash === hash) {
      state.characters[id] = { version: remote.version, hash };
      pulled.push({ id, version: remote.version, action: "unchanged" });
      continue;
    }
    const unpushed = file && localHash !== state.characters[id]?.hash;
    if (unpushed && !input.force) {
      pulled.push({ id, version: remote.version, action: "kept_local" });
      continue;
    }
    writeCharacterFile(root, remote.config);
    state.characters[id] = { version: remote.version, hash };
    pulled.push({ id, version: remote.version, action: "written" });
  }
  writeRouterState(root, state);

  const kept = pulled.filter((p) => p.action === "kept_local").map((p) => p.id);
  if (kept.length) {
    return failure(
      "local_changes",
      `${kept.join(", ")} ha${kept.length === 1 ? "s" : "ve"} local edits that were never pushed. Kept them; Summer's version was not written.`,
      `Push them with router.push, or take Summer's version with router.pull and force.`,
      { details: { game_id: game.gameId, pulled } }
    );
  }
  return success({ game_id: game.gameId, pulled });
}

