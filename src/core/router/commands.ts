import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { RouterApiError, seg, type RouterApi } from "./api.js";
import { handlerSnippet, scanToolHandlers, unhandledClientTools, type HandlerMap } from "./handlers.js";
import { apiFailure, failure, success, usageError, type RouterOutcome } from "./outcome.js";
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
import { loadRegistry, validateCharacter, validateSettings, type RouterRegistry } from "./registry.js";
import { studioGamesUrl, studioRouterUrl } from "./studio.js";
import { buildCharacter, parseToolList, TEMPLATES, TOOL_NAME, type TemplateId } from "./templates.js";

/** Everything a Summer Router command touches outside its arguments (fakes in tests). */
export interface RouterContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  api: RouterApi;
  gateway: () => Promise<string>;
  randomId: () => string;
  now: () => number;
  /** --project */
  project?: string;
  /** --game */
  game?: string;
}

interface StoredCharacter {
  character_id: string;
  version: number;
  config: Record<string, unknown>;
  deleted?: boolean;
}

const NOT_SERVED = "This Summer does not serve this Summer Router route yet. Update the CLI, or retry after the platform release.";

function projectRoot(ctx: RouterContext): string | null {
  return findProjectRoot(ctx.project ? resolve(ctx.cwd, ctx.project) : ctx.cwd);
}

function noProject(ctx: RouterContext): RouterOutcome {
  return usageError(
    "not_a_project",
    `No project.godot at or above ${ctx.project ? resolve(ctx.cwd, ctx.project) : ctx.cwd}.`,
    "Run the command inside the Summer project, or pass --project <dir>."
  );
}

async function requireGame(ctx: RouterContext, root: string | null): Promise<{ gameId: string } | RouterOutcome> {
  const { gameId } = resolveGameId(root, ctx.game, ctx.env);
  if (gameId) return { gameId };
  return failure(
    {
      code: "game_id_missing",
      message: "No game id: Summer Router settings belong to one game on Summer.",
      fix: "Pass --game <gameId>, set SUMMER_GAME_ID, or add gameId to summer.build.json. Studio lists your games and their ids.",
      studio_url: studioGamesUrl(await ctx.gateway()),
    },
    { exit: 2 }
  );
}

const isOutcome = (value: unknown): value is RouterOutcome =>
  Boolean(value && typeof value === "object" && "exitCode" in (value as object) && "result" in (value as object));

/** A missing route answers 404 without a message (the store proxy) or with plain text (the platform mux). */
function isRouteMissing(error: unknown): boolean {
  return error instanceof RouterApiError && error.status === 404 && /^Summer refused the request/.test(error.message);
}

// ---------------------------------------------------------------- character add

export interface CharacterAddOptions {
  id: string;
  template?: string;
  name?: string;
  voice?: string;
  voiceId?: string;
  tools?: string;
  force?: boolean;
}

export async function characterAdd(ctx: RouterContext, opts: CharacterAddOptions): Promise<RouterOutcome> {
  if (!CHARACTER_ID.test(opts.id)) {
    return usageError("invalid_input", `"${opts.id}" is not a character id.`, "Use a lowercase letter first, then lowercase letters, digits, _ or -, at most 64 characters (for example guard).");
  }
  const template = (opts.template ?? "voice-npc") as TemplateId;
  if (!TEMPLATES.includes(template)) {
    return usageError("invalid_input", `Unknown template "${opts.template}".`, `Use one of: ${TEMPLATES.join(", ")}.`);
  }
  const tools = parseToolList(opts.tools);
  const badTool = tools.find((tool) => !TOOL_NAME.test(tool));
  if (badTool) {
    return usageError("invalid_input", `"${badTool}" is not a tool name.`, "Use a letter or _ first, then letters, digits or _, at most 64 characters (for example open_gate).");
  }
  if (opts.voice && opts.voiceId) {
    return usageError("invalid_input", "--voice and --voice-id both set.", "Pass a voice description with --voice, or a Summer voice id with --voice-id, not both.");
  }
  const root = projectRoot(ctx);
  if (!root) return noProject(ctx);
  const path = characterPath(root, opts.id);
  if (existsSync(path) && !opts.force) {
    return failure({ code: "character_exists", message: `${CHARACTERS_DIR}/${opts.id}.json already exists.`, fix: "Edit that file, or pass --force to replace it with the template." });
  }

  const doc = buildCharacter({ id: opts.id, template, name: opts.name, voice: opts.voice, voiceId: opts.voiceId, tools });
  const { registry } = await loadRegistry(null);
  const issues = validateCharacter(doc, registry);
  if (issues.length > 0) {
    return failure({ code: "invalid_character", message: "The new character does not match the registry schema.", fix: "Shorten the name or voice description and retry.", details: issues });
  }
  writeCharacterFile(root, doc);

  const handlers = scanToolHandlers(root);
  const unhandled = unhandledClientTools([{ id: opts.id, doc }], handlers);
  const nextSteps = [
    ...(unhandled.length ? [`Add a GDScript handler for each client tool (${unhandled.map((t) => t.tool).join(", ")}): see handler_snippet.`] : []),
    `Edit ${CHARACTERS_DIR}/${opts.id}.json: instructions, tool descriptions and parameters.`,
    "summer router push",
    `summer router test ${opts.id} --say "hello"${tools[0] ? ` --expect-tool ${tools[0]}` : ""}`,
  ];
  return success(
    {
      character: opts.id,
      path: `${CHARACTERS_DIR}/${opts.id}.json`,
      template,
      document: doc,
      unhandled_tools: unhandled.map((t) => t.tool),
      ...(unhandled.length ? { handler_snippet: handlerSnippet(unhandled) } : {}),
      next_steps: nextSteps,
    },
    [
      `Wrote ${CHARACTERS_DIR}/${opts.id}.json (template ${template}).`,
      ...(unhandled.length ? ["", "Add these handlers in GDScript before you push:", handlerSnippet(unhandled)] : []),
      "",
      "Next:",
      ...nextSteps.map((step) => `  ${step}`),
    ]
  );
}

// ---------------------------------------------------------------- push

export interface PushOptions {
  ids?: string[];
  dryRun?: boolean;
  force?: boolean;
}

interface LocalCheck {
  files: CharacterFile[];
  registry: RouterRegistry;
  registrySource: string;
  handlers: HandlerMap;
}

async function checkLocal(ctx: RouterContext, root: string, ids: string[] | undefined, live: boolean): Promise<LocalCheck | RouterOutcome> {
  const all = readCharacterFiles(root);
  const missing = (ids ?? []).filter((id) => !all.some((file) => file.id === id));
  if (missing.length) {
    return usageError("character_not_found", `No ${missing.map((id) => `${CHARACTERS_DIR}/${id}.json`).join(", ")}.`, `Create it with: summer router character add ${missing[0]} --template voice-npc`);
  }
  const files = ids?.length ? all.filter((file) => ids.includes(file.id)) : all;
  if (files.length === 0) {
    return failure({ code: "no_characters", message: `No characters in ${CHARACTERS_DIR}/.`, fix: "Create one: summer router character add guard --template voice-npc --tools open_gate" });
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
      {
        code: "invalid_character",
        message: `${invalid.length} problem${invalid.length === 1 ? "" : "s"} in ${CHARACTERS_DIR}/: ${invalid
          .slice(0, 5)
          .map((issue) => `${issue.character}${issue.path} ${issue.message}`)
          .join("; ")}.`,
        fix: "Fix each field listed in details, then run summer router push --dry-run again.",
        details: invalid,
      },
      { lines: invalid.map((issue) => `  ${issue.character}${issue.path}: ${issue.message}`) }
    );
  }
  const handlers = scanToolHandlers(root);
  const unhandled = unhandledClientTools(files, handlers);
  if (unhandled.length) {
    const snippet = handlerSnippet(unhandled);
    return failure(
      {
        code: "tool_unhandled",
        message: `No GDScript handler for ${unhandled.map((t) => `${t.character}.${t.tool}`).join(", ")}. The character could call it and nothing in the game would answer.`,
        fix: "Register each tool in the character's tools Dictionary (shape in details.handler_snippet), then push again.",
        docs_url: "https://docs.summerengine.com/router/gdscript#tools",
        details: { unhandled, handler_snippet: snippet },
      },
      { lines: ["Add these handlers in GDScript:", snippet, ""] }
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

export async function push(ctx: RouterContext, opts: PushOptions): Promise<RouterOutcome> {
  const root = projectRoot(ctx);
  if (!root) return noProject(ctx);
  const checked = await checkLocal(ctx, root, opts.ids, !opts.dryRun);
  if (isOutcome(checked)) return checked;
  const { files, handlers } = checked;
  const summary = files.map((file) => ({ id: file.id, client_tools: clientTools(file, handlers) }));

  if (opts.dryRun) {
    return success(
      { dry_run: true, registry_source: checked.registrySource, characters: summary, next_steps: ["summer router push"] },
      [
        `${files.length} character${files.length === 1 ? "" : "s"} valid; every client tool has a handler.`,
        ...summary.map((c) => `  ${c.id}${c.client_tools.length ? `: ${c.client_tools.map((t) => `${t.name} (${t.handled_in[0]})`).join(", ")}` : ""}`),
        "Run summer router push to send them to Summer.",
      ]
    );
  }

  const game = await requireGame(ctx, root);
  if (isOutcome(game)) return game;
  const gateway = await ctx.gateway();
  const studio = studioRouterUrl(gateway, game.gameId);
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
      if (remote && !remote.deleted && !opts.force && known?.version !== remote.version) {
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

  const first = files[0].id;
  const firstTool = clientTools(files[0], handlers)[0]?.name;
  const testStep = `summer router test ${first} --say "hello"${firstTool ? ` --expect-tool ${firstTool}` : ""}`;
  if (conflicts.length) {
    return failure(
      {
        code: "studio_changed",
        message: `Summer has a newer version of ${conflicts.map((c) => c.id).join(", ")} than this project last saw (edited in Studio or by someone else). Not pushed, so nothing was overwritten.`,
        fix: `Run summer router pull ${conflicts.map((c) => c.id).join(" ")} to take Summer's version, or summer router push --force to replace it with yours.`,
        studio_url: studio,
        details: conflicts,
      },
      { result: { game_id: game.gameId, pushed } }
    );
  }
  return success(
    { game_id: game.gameId, pushed, studio_url: studio, next_steps: [testStep] },
    [...pushed.map((p) => `  ${p.id}: ${p.action} (version ${p.version})`), `Studio: ${studio}`, `Next: ${testStep}`]
  );
}

// ---------------------------------------------------------------- pull

export interface PullOptions {
  ids?: string[];
  force?: boolean;
}

export async function pull(ctx: RouterContext, opts: PullOptions): Promise<RouterOutcome> {
  const root = projectRoot(ctx);
  if (!root) return noProject(ctx);
  const game = await requireGame(ctx, root);
  if (isOutcome(game)) return game;
  let list: StoredCharacter[];
  try {
    const answer = await ctx.api.request<{ characters?: StoredCharacter[] }>("GET", `games/${seg(game.gameId)}/router/characters`);
    list = (answer.characters ?? []).filter((character) => !character.deleted);
  } catch (error) {
    return apiFailure(error, { notFound: isRouteMissing(error) ? NOT_SERVED : `Summer has no game ${game.gameId} for this account.` });
  }
  if (opts.ids?.length) {
    const missing = opts.ids.filter((id) => !list.some((character) => character.character_id === id));
    if (missing.length) {
      return failure({ code: "character_not_found", message: `Summer has no character ${missing.join(", ")} for game ${game.gameId}.`, fix: "Run summer router pull with no ids to list what Summer has." });
    }
    list = list.filter((character) => opts.ids!.includes(character.character_id));
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
    if (unpushed && !opts.force) {
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
      {
        code: "local_changes",
        message: `${kept.join(", ")} ha${kept.length === 1 ? "s" : "ve"} local edits that were never pushed. Kept them; Summer's version was not written.`,
        fix: `Push them (summer router push ${kept.join(" ")}), or replace them with Summer's version (summer router pull ${kept.join(" ")} --force).`,
      },
      { result: { game_id: game.gameId, pulled } }
    );
  }
  return success(
    { game_id: game.gameId, pulled },
    pulled.length ? pulled.map((p) => `  ${p.id}: ${p.action} (version ${p.version})`) : [`Summer has no characters for game ${game.gameId}.`]
  );
}

// ---------------------------------------------------------------- test

export interface TestOptions {
  id: string;
  say?: string;
  expectTools?: string[];
  context?: string;
  vars?: string[];
}

interface ReplyResult {
  request_id?: string;
  exchange_id?: string;
  text?: string;
  tool_calls?: Array<{ call_id: string; name: string; args: unknown; runs_on?: string }>;
  usage?: Record<string, number>;
}

export function parseVars(pairs: string[] | undefined): Record<string, string> | RouterOutcome {
  const vars: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return usageError("invalid_input", `--var expects name=value, got "${pair}".`, "Pass --var name=value once per variable.");
    vars[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return vars;
}

export async function test(ctx: RouterContext, opts: TestOptions): Promise<RouterOutcome> {
  if (!opts.say?.trim()) return usageError("invalid_input", "--say is required.", `Pass what the player says: summer router test ${opts.id} --say "hello"`);
  const vars = parseVars(opts.vars);
  if (isOutcome(vars)) return vars;
  const root = projectRoot(ctx);
  const game = await requireGame(ctx, root);
  if (isOutcome(game)) return game;
  const studio = studioRouterUrl(await ctx.gateway(), game.gameId);
  let reply: ReplyResult;
  try {
    reply = await ctx.api.request<ReplyResult>("POST", `games/${seg(game.gameId)}/router/characters/${seg(opts.id)}:test`, {
      body: {
        request_id: ctx.randomId(),
        text: opts.say,
        ...(Object.keys(vars).length ? { variables: vars } : {}),
        ...(opts.context ? { context: opts.context } : {}),
      },
    });
  } catch (error) {
    const { registry } = await loadRegistry(null);
    return apiFailure(error, {
      registry,
      studioUrl: studio,
      notFound: isRouteMissing(error) ? NOT_SERVED : `Summer has no character "${opts.id}" for game ${game.gameId}. Run summer router push first.`,
    });
  }
  const calls = reply.tool_calls ?? [];
  const expected = (opts.expectTools ?? []).map((name) => ({ name, called: calls.some((call) => call.name === name) }));
  const result = {
    game_id: game.gameId,
    character: opts.id,
    said: opts.say,
    reply: reply.text ?? "",
    tool_calls: calls,
    expected_tools: expected,
    usage: reply.usage ?? {},
    exchange_id: reply.exchange_id,
  };
  const lines = [
    `${opts.id}: ${reply.text ?? ""}`,
    ...calls.map((call) => `  tool call: ${call.name} ${JSON.stringify(call.args)}`),
    ...expected.map((e) => `  ${e.called ? "called" : "NOT called"}: ${e.name}`),
  ];
  const missed = expected.filter((e) => !e.called).map((e) => e.name);
  if (missed.length) {
    return failure(
      {
        code: "expectation_failed",
        message: `The character did not call ${missed.join(", ")}.`,
        fix: "Make the tool description say exactly when to call it, and the instructions say to call it instead of describing it. Push, then test again.",
      },
      { result, lines }
    );
  }
  return success(result, lines);
}

// ---------------------------------------------------------------- limits

const USD = /^\d+(\.\d{1,6})?$/;
const toUsd = (micro: unknown) => (typeof micro === "number" ? micro / 1_000_000 : null);

export interface LimitsSetOptions {
  playerDay?: string;
  gameDay?: string;
  gameMonth?: string;
  accountMonth?: string;
  enabled?: string;
  textModel?: string;
  imageModel?: string;
}

interface Settings {
  game_id: string;
  enabled: boolean;
  text_model?: string;
  image_model?: string;
  caps?: Record<string, number>;
  default_caps?: Record<string, number>;
  revision: number;
}

function capsInUsd(caps: Record<string, number> | undefined) {
  return {
    player_day_usd: toUsd(caps?.player_day_micro_usd),
    game_day_usd: toUsd(caps?.game_day_micro_usd),
    game_month_usd: toUsd(caps?.game_month_micro_usd),
  };
}

export async function limitsGet(ctx: RouterContext): Promise<RouterOutcome> {
  const root = projectRoot(ctx);
  const game = await requireGame(ctx, root);
  if (isOutcome(game)) return game;
  const studio = studioRouterUrl(await ctx.gateway(), game.gameId);
  try {
    const g = seg(game.gameId);
    const settings = await ctx.api.request<Settings>("GET", `games/${g}/router/settings`);
    const usage = await ctx.api
      .request<{ caps?: Array<{ scope: string; used_percent: number; resets_at: string }> }>("GET", `games/${g}/router/usage`, { query: { days: 1 } })
      .catch(() => ({ caps: [] }));
    const account = await ctx.api
      .request<{ monthly_micro_usd?: number; used_percent?: number }>("GET", "me/router/account-limit")
      .catch(() => null);
    const used = (usage.caps ?? []).map((cap) => ({ scope: cap.scope, used_percent: cap.used_percent, resets_at: cap.resets_at }));
    const caps = capsInUsd(settings.caps);
    return success(
      {
        game_id: game.gameId,
        enabled: settings.enabled,
        text_model: settings.text_model ?? null,
        image_model: settings.image_model ?? null,
        caps,
        default_caps: capsInUsd(settings.default_caps),
        account_month_usd: toUsd(account?.monthly_micro_usd),
        used,
        revision: settings.revision,
        studio_url: studio,
      },
      [
        `Summer Router is ${settings.enabled ? "on" : "off"} for ${game.gameId}.`,
        `Caps (USD): per player per day ${caps.player_day_usd ?? "default"}, per game per day ${caps.game_day_usd ?? "default"}, per game per month ${caps.game_month_usd ?? "default"}, per account per month ${toUsd(account?.monthly_micro_usd) ?? "default"}.`,
        ...used.map((u) => `  ${u.scope}: ${u.used_percent}% used, resets ${u.resets_at}`),
        `Studio: ${studio}`,
      ]
    );
  } catch (error) {
    return apiFailure(error, { studioUrl: studio, notFound: isRouteMissing(error) ? NOT_SERVED : `Summer has no game ${game.gameId} for this account.` });
  }
}

export async function limitsSet(ctx: RouterContext, opts: LimitsSetOptions): Promise<RouterOutcome> {
  const caps: Record<string, number> = {};
  for (const [flag, key, value] of [
    ["--player-day", "player_day_micro_usd", opts.playerDay],
    ["--game-day", "game_day_micro_usd", opts.gameDay],
    ["--game-month", "game_month_micro_usd", opts.gameMonth],
  ] as const) {
    if (value === undefined) continue;
    if (!USD.test(value.trim())) return usageError("invalid_input", `${flag} must be an amount in US dollars, like 0.50, got "${value}".`, `Pass ${flag} <amount>, for example ${flag} 2.50.`);
    caps[key] = Math.round(Number(value) * 1_000_000);
  }
  let accountMonth: number | undefined;
  if (opts.accountMonth !== undefined) {
    if (!USD.test(opts.accountMonth.trim())) return usageError("invalid_input", `--account-month must be an amount in US dollars, got "${opts.accountMonth}".`, "Pass --account-month <amount>, for example --account-month 50.");
    accountMonth = Math.round(Number(opts.accountMonth) * 1_000_000);
  }
  let enabled: boolean | undefined;
  if (opts.enabled !== undefined) {
    const value = opts.enabled.trim().toLowerCase();
    if (!["on", "off", "true", "false"].includes(value)) return usageError("invalid_input", `--enabled must be on or off, got "${opts.enabled}".`, "Pass --enabled on or --enabled off.");
    enabled = value === "on" || value === "true";
  }
  if (!Object.keys(caps).length && accountMonth === undefined && enabled === undefined && !opts.textModel && !opts.imageModel) {
    return usageError("invalid_input", "Nothing to set.", "Pass at least one of --player-day, --game-day, --game-month, --account-month, --enabled, --text-model, --image-model.");
  }

  const root = projectRoot(ctx);
  const game = await requireGame(ctx, root);
  if (isOutcome(game)) return game;
  const studio = studioRouterUrl(await ctx.gateway(), game.gameId);
  const { registry } = await loadRegistry(null);
  const g = seg(game.gameId);
  const result: Record<string, unknown> = { game_id: game.gameId };
  try {
    if (Object.keys(caps).length || enabled !== undefined || opts.textModel || opts.imageModel) {
      const current = await ctx.api.request<Settings>("GET", `games/${g}/router/settings`);
      const body: Record<string, unknown> = { expected_revision: current.revision };
      if (enabled !== undefined) body.enabled = enabled;
      if (opts.textModel) body.text_model = opts.textModel;
      if (opts.imageModel) body.image_model = opts.imageModel;
      if (Object.keys(caps).length) body.caps = { ...(current.caps ?? {}), ...caps };
      const issues = validateSettings(body, registry);
      if (issues.length) {
        return usageError("invalid_input", issues.map((issue) => `${issue.path || "settings"} ${issue.message}`).join("; "), "Use values inside the limits the message names.");
      }
      const saved = await ctx.api.request<Settings>("PUT", `games/${g}/router/settings`, { body });
      Object.assign(result, { enabled: saved.enabled, caps: capsInUsd(saved.caps), revision: saved.revision });
    }
    if (accountMonth !== undefined) {
      const saved = await ctx.api.request<{ monthly_micro_usd: number }>("PUT", "me/router/account-limit", { body: { monthly_micro_usd: accountMonth } });
      result.account_month_usd = toUsd(saved.monthly_micro_usd);
    }
  } catch (error) {
    return apiFailure(error, { registry, studioUrl: studio, notFound: isRouteMissing(error) ? NOT_SERVED : `Summer has no game ${game.gameId} for this account.` });
  }
  return success({ ...result, studio_url: studio }, ["Saved.", `Studio: ${studio}`]);
}

// ---------------------------------------------------------------- logs

export function parseSince(raw: string | undefined, now: number): number | RouterOutcome {
  const value = (raw ?? "1h").trim();
  const relative = value.match(/^(\d+)\s*(s|m|h|d)$/);
  if (relative) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "s" | "m" | "h" | "d"];
    return now - Number(relative[1]) * unit;
  }
  const absolute = Date.parse(value);
  if (!Number.isNaN(absolute)) return absolute;
  return usageError("invalid_input", `--since must be a duration (10m, 2h, 3d) or a date, got "${raw}".`, "Pass --since 10m, --since 2h, or --since 2026-10-14T12:00:00Z.");
}

export interface LogsOptions {
  since?: string;
  limit?: string;
  character?: string;
}

export async function logs(ctx: RouterContext, opts: LogsOptions): Promise<RouterOutcome> {
  const since = parseSince(opts.since, ctx.now());
  if (isOutcome(since)) return since;
  const limit = opts.limit === undefined ? 100 : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return usageError("invalid_input", `--limit must be 1 to 1000, got "${opts.limit}".`, "Pass --limit 100.");
  const root = projectRoot(ctx);
  const game = await requireGame(ctx, root);
  if (isOutcome(game)) return game;
  const g = seg(game.gameId);
  const sinceIso = new Date(since).toISOString();
  try {
    const answer = await ctx.api.request<{ calls?: Array<Record<string, unknown>> }>("GET", `games/${g}/router/logs`, {
      query: { since: sinceIso, limit, character: opts.character },
    });
    const calls = answer.calls ?? [];
    return success(
      { game_id: game.gameId, source: "calls", since: sinceIso, calls },
      calls.length
        ? calls.map((call) => `  ${call.at ?? ""} ${call.kind ?? ""} ${call.character ?? ""} ${call.status ?? ""} ${call.error ?? ""} ${call.request_id ?? ""}`.replace(/\s+/g, " "))
        : [`No Summer Router calls since ${sinceIso}.`]
    );
  } catch (error) {
    if (!isRouteMissing(error)) return apiFailure(error, { notFound: `Summer has no game ${game.gameId} for this account.` });
  }
  // Per-call records are not served yet: daily totals per kind instead.
  try {
    const days = Math.min(90, Math.max(1, Math.ceil((ctx.now() - since) / 86_400_000)));
    const usage = await ctx.api.request<{ days?: Array<Record<string, unknown>> }>("GET", `games/${g}/router/usage`, { query: { days } });
    const rows = usage.days ?? [];
    return success(
      {
        game_id: game.gameId,
        source: "daily_usage",
        since: sinceIso,
        days: rows,
        warning: "This Summer does not serve per-call logs yet; these are daily totals per kind.",
      },
      [
        "Per-call logs are not served yet; daily totals per kind:",
        ...rows.map((row) => `  ${row.day} ${row.kind}: ${row.calls} calls, ${row.failed} failed`),
      ]
    );
  } catch (error) {
    return apiFailure(error, { notFound: isRouteMissing(error) ? NOT_SERVED : `Summer has no game ${game.gameId} for this account.` });
  }
}
