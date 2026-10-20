import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureGameplay, type CaptureGameplayInput } from "../../core/capabilities/capture-gameplay.js";
import { exportGame } from "../../core/capabilities/export-game.js";
import { STORE_TARGETS } from "../../core/capabilities/export-presets.js";
import { exportTemplates, TEMPLATE_PLATFORMS } from "../../core/capabilities/export-templates.js";
import { goLive } from "../../core/capabilities/go-live.js";
import { publishBuild } from "../../core/capabilities/publish-build.js";
import { AI_USES, STORE_FEATURES, setStoreDetails, SURVEY_LEVELS } from "../../core/capabilities/store-details.js";
import { BuildToolError, buildToolFailure } from "../../core/capabilities/summer-bundle.js";
import { syncItems } from "../../core/capabilities/sync-items.js";
import { contentMake, contentMakeInput } from "../../core/capabilities/content-make/index.js";
import { textJson } from "./text-json.js";

async function creatorResult<T>(operation: () => Promise<T>) {
  try {
    return textJson(await operation());
  } catch (error) {
    if (error instanceof BuildToolError) return textJson(buildToolFailure(error), true);
    return textJson(
      {
        ok: false,
        code: "creator_request_invalid",
        message: error instanceof Error ? error.message : String(error),
      },
      true
    );
  }
}

export function registerCreatorTools(server: McpServer): void {
  server.tool(
    "summer_export_game",
    "Export the game in the exact file the Summer Games store takes, with the installed Summer Engine headless (no window). format \"bundle\" (default): the summer.games .zip the Summer apps run on iPhone, Android, macOS and Windows; targets picks the platforms (a game without a server: ios and android only); upload it with summer_publish_build. format \"download\" with one target: web (an HTML5 .zip on Summer's WebGPU Forward+ web template, played on summer.games), macos (.app zip, macos-universal) or windows (.exe zip, windows-x64); these need the export template from summer_export_templates and are uploaded as store versions. Needs Summer Engine 0.7.0 or newer: an older engine is refused before anything is written (code engine_too_old). A target the installed engine cannot build (android needs 0.7.1) is left out: the other targets export, and skippedTargets plus a warning name it. A game with a server declares its platforms in summer.build.json; when they differ from the exported targets a warning says so (summer_publish_build would be refused), and alignDeclaration:true aligns them. Works without the editor running. Returns path, sha256, size, the manifest or store platform, and warnings.",
    {
      project: z.string().optional().describe("Project folder with project.godot. Defaults to the MCP's bound project, then the working directory."),
      out: z.string().optional().describe("Output .zip path. Defaults to <project>/.summer/exports/."),
      targets: z
        .array(z.enum(STORE_TARGETS))
        .optional()
        .describe("Store platforms. Bundle: any of macos, windows, ios, android (omit to use every platform the project declares). Download: exactly one of web, macos, windows."),
      format: z
        .enum(["bundle", "download"])
        .optional()
        .describe("bundle (default): the summer.games store build. download: a web build or native download; the default when targets is [\"web\"]."),
      debug: z.boolean().default(false).describe("Export a debug build (--export-debug)."),
      timeoutSeconds: z.number().int().min(10).max(7200).optional().describe("Stop the engine after this many seconds (default 900; a first export imports every asset)."),
      alignDeclaration: z
        .boolean()
        .optional()
        .describe("A game with a server: set summer.build.json targetPlatforms to targets before exporting. The store refuses an upload whose declaration differs from the exported platforms (declaration_mismatch) and that spends the version."),
    },
    async ({ project, out, targets, format, debug, timeoutSeconds, alignDeclaration }) =>
      creatorResult(() =>
        exportGame({ project, out, targets, format, debug, alignDeclaration, ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}) })
      )
  );

  server.tool(
    "summer_export_templates",
    "List, download and install Summer Engine export templates from Summer's CDN into the folder the installed engine reads, checking each file's sha256. Needed only for summer_export_game format \"download\": web (Summer's WebGPU Forward+ template), macos, windows. Store bundles (format \"bundle\") need no template. action list shows what is installed and published; action install fetches the platforms asked (default web).",
    {
      action: z.enum(["list", "install"]).describe("list: installed and published templates. install: download and install."),
      platforms: z
        .array(z.enum(TEMPLATE_PLATFORMS))
        .optional()
        .describe("Template platforms to install (default [\"web\"])."),
      includeDebug: z.boolean().default(false).describe("Also install the debug templates (for exports with debug true)."),
      summerVersion: z
        .string()
        .optional()
        .describe("The installed Summer Engine version (Help > About, e.g. 0.7.1). Read automatically on macOS; needed on Windows and Linux."),
    },
    async ({ action, platforms, includeDebug, summerVersion }) =>
      creatorResult(() => exportTemplates({ action, platforms, includeDebug, summerVersion }))
  );

  server.tool(
    "summer_capture_gameplay",
    "Capture real gameplay frames without a running editor: starts the game in Summer Engine's offscreen verify instance (--summer-offscreen: a real renderer, a window parked offscreen with no focus, never on screen), lets it run waitSeconds, runs steps, and saves PNG frames of what the game draws, HUD included. Use for store screenshots (1920x1080 landscape or 1080x1920 portrait). The main scene is often a title menu: pass the game's own flags in args (after \"--\", e.g. [\"--autostart\"]), a gameplay scene, or steps that play like a player: [{press:\"Play\"}, {wait:3000}, {key:\"Space\"}, {action:\"jump\"}, {click:[960,540]}, {drag:{from:[400,800],to:[1400,800]}}, {shot:true}]. With a shot step, only shot steps save frames; without one, frames are saved after the steps. A step that cannot run (no such button, key or action) becomes a warning. With an editor open, summer_screenshot target game also works. Returns each frame's path, width and height; look at them before using them.",
    {
      project: z.string().optional().describe("Project folder with project.godot. Defaults to the MCP's bound project, then the working directory."),
      scene: z.string().optional().describe("Scene to start (res://... or uid://...). Default: the project's main scene, which is often a title menu; pass the gameplay scene for gameplay frames."),
      resolution: z.string().optional().describe("Window size WIDTHxHEIGHT (default 1920x1080; 1080x1920 for portrait)."),
      frames: z.number().int().min(1).max(10).optional().describe("Frames to save (default 1)."),
      waitSeconds: z.number().min(0).max(120).optional().describe("Seconds the game runs before the first frame (default 3)."),
      intervalSeconds: z.number().min(0.1).max(60).optional().describe("Seconds between frames (default 1)."),
      out: z.string().optional().describe("Output folder. Defaults to <project>/.summer/captures/<time>/ (ignored by git)."),
      args: z
        .array(z.string())
        .max(32)
        .optional()
        .describe('The game\'s own command-line flags, passed after "--" (OS.get_cmdline_user_args()), e.g. ["--autostart", "--solo"] to skip the title screen.'),
      steps: z
        .array(
          z
            .object({
              press: z.string().optional().describe("Press the visible button with this text (or node name); waits up to timeoutSeconds (default 10) for it."),
              timeoutSeconds: z.number().min(0).max(60).optional(),
              key: z.string().optional().describe("Press a key by Godot name: Space, Enter, Escape, A, Up."),
              action: z.string().optional().describe("Press an input action from the project's InputMap, e.g. jump."),
              holdMs: z.number().min(0).max(10000).optional().describe("How long key or action is held (default 100)."),
              click: z.tuple([z.number(), z.number()]).optional().describe("Left-click at [x, y] in frame pixels."),
              drag: z
                .object({ from: z.tuple([z.number(), z.number()]), to: z.tuple([z.number(), z.number()]), ms: z.number().min(0).max(10000).optional() })
                .optional()
                .describe("Drag with the left button from [x, y] to [x, y] over ms (default 300)."),
              wait: z.number().min(0).max(60000).optional().describe("Wait this many milliseconds."),
              shot: z.boolean().optional().describe("true: save a frame now."),
            })
            .strict()
        )
        .max(50)
        .optional()
        .describe("What to do after waitSeconds, in order; exactly one of press, key, action, click, drag, wait, shot per step."),
    },
    async (args) => creatorResult(() => captureGameplay(args as CaptureGameplayInput))
  );

  server.tool(
    "summer_publish_build",
    "Upload an export from summer_export_game to the creator's game on summer.games, through the same store upload Studio uses, straight from disk. A store bundle (format bundle): declare, upload parts, seal, wait until Summer makes the Build, name its client pack and wait for Summer's automated checks on each platform (checks: passed, or failed with the code and the fix). A web build or native download (format download): upload it as the game's store version for its platform (web, macos-universal, windows-x64, linux-x64; read from the last export) and wait until Summer has checked it. First call with confirm=false: it checks that the game exists for this account and warns when its store page does not list the export's platforms, then returns the target (game name and id, file, digest, size, version) to show the user; set confirm only after they approve. Needs \"summer login --store\". A retry with the same file and clientVersion continues the same upload. Going live is summer_go_live.",
    {
      gameId: z.string().optional().describe("The store game id (from games.list, or the Studio store page URL). Without it the call fails with game_required and lists your store games, or says why the store did not list them."),
      file: z.string().optional().describe("Exported .zip. Defaults to the last summer_export_game result."),
      clientVersion: z.string().describe("Build version, vMAJOR.MINOR.PATCH (e.g. v1.0.0); a new upload needs a new version."),
      publish: z.boolean().default(false).describe("Bundles only: also make the Build available to players once its checks pass. summer_go_live does this, the release and the store page in one step."),
      platform: z
        .enum(["web", "macos-universal", "windows-x64", "linux-x64"])
        .optional()
        .describe("Web builds and native downloads: the store platform. Defaults to the last export's platform; omit for a store bundle."),
      confirm: z.boolean().default(false).describe("Set true only after the user approves the exact upload."),
      waitSeconds: z.number().int().min(0).max(1800).optional().describe("How long to wait for Summer to make the Build (default 600). On timeout, call again to keep waiting."),
    },
    async (args) => creatorResult(() => publishBuild({ ...args, face: "mcp" }))
  );

  server.tool(
    "summer_go_live",
    "Take a store game live for players: release its uploaded bundle Build (publicationId, or the newest upload) to every platform that passed Summer's automated checks, and publish its store page, through the same store routes Studio uses; then watch until players get it. It runs without an owner approval while the person's Agent permissions allow Publish (the default). First call with confirm=false: it reads the page, the Build and its per-platform checks and what players get now, and returns live, blocked (each failure with its fix), needs_changes (Summer's decision and feedback) or confirmation_required with the plan to show the user; set confirm only after they approve going live. With confirm=true it asks the platform and polls until live, or answers waiting with waitingOn (automated_checks, activation, or summer: a hold on Summer's side that needs nothing from the creator; never tell them to wait for a review). Call again with confirm=true to keep watching: nothing is asked twice. notIncluded lists the platforms a hosted release left out (its client is not qualified against the server Build), each with the line to tell the creator; notUsed lists newer clients it did not use (that platform stays live with its current client), with the platform's message. needs_permission: Publish is off in the person's Agent permissions. Web builds and downloads go live with the page. Needs \"summer login --store\".",
    {
      gameId: z.string().optional().describe("The store game id (from games.list). Without it the call fails with game_required and lists your store games."),
      publicationId: z.string().optional().describe("The bundle Build to release: publicationId from summer_publish_build. Default: the newest uploaded export."),
      confirm: z.boolean().default(false).describe("Set true only after the user approves taking this exact page and Build live."),
      waitSeconds: z.number().int().min(0).max(1800).optional().describe("How long to watch before answering (default 600). On waiting, call again to keep watching."),
    },
    async (args) => creatorResult(() => goLive({ ...args, face: "mcp" }))
  );

  server.tool(
    "summer_store_set_details",
    "Fill the store page sections store.update_listing does not edit, on the store page draft: genres (1-5 genre tag ids from store.get_listing tags), features, credits, languageSupport, systemRequirements, contentSurvey (the age questionnaire: every answer, none included) and aiDisclosure (how AI was used; an empty uses list means no AI). Each section given replaces that section, null clears it, an omitted one keeps its value. A published page gets a new draft first. Saving never publishes: take it live with summer_go_live. Needs \"summer login --store\".",
    {
      gameId: z.string().optional().describe("The store game id (from games.list)."),
      genres: z.array(z.string()).min(1).max(5).nullable().optional().describe("Genre tag ids (category genre in store.get_listing tags), in the creator's order."),
      features: z.array(z.enum(STORE_FEATURES)).min(1).nullable().optional().describe("What the game offers, from the store's closed list."),
      credits: z
        .object({ developer: z.string().min(1).max(120), publisher: z.string().min(1).max(120).optional(), franchise: z.string().min(1).max(120).optional() })
        .nullable()
        .optional()
        .describe("Who made and published it; omit publisher or franchise when there is none."),
      languageSupport: z
        .array(z.object({ code: z.string(), interface: z.boolean(), fullAudio: z.boolean(), subtitles: z.boolean() }))
        .min(1)
        .max(30)
        .nullable()
        .optional()
        .describe("One entry per language (BCP 47 code: en, pt-br, zh-hans), each with at least one kind of support."),
      systemRequirements: z
        .record(z.string(), z.unknown())
        .nullable()
        .optional()
        .describe("Desktop hardware: { windows | macos | linux: { minimum: { os, processor, memory, graphics, storage, network, notes }, recommended? } }."),
      contentSurvey: z
        .object({
          violence: z.enum(SURVEY_LEVELS.violence),
          bloodGore: z.enum(SURVEY_LEVELS.bloodGore),
          sexualContent: z.enum(SURVEY_LEVELS.sexualContent),
          nudity: z.enum(SURVEY_LEVELS.nudity),
          language: z.enum(SURVEY_LEVELS.language),
          substances: z.enum(SURVEY_LEVELS.substances),
          gambling: z.enum(SURVEY_LEVELS.gambling),
          userGeneratedContent: z.boolean(),
          onlineInteraction: z.boolean(),
          inGamePurchases: z.boolean(),
          notes: z.string().max(1000).optional(),
        })
        .nullable()
        .optional()
        .describe("The mature-content questionnaire; every answer is required, none is an answer."),
      aiDisclosure: z
        .object({ uses: z.array(z.enum(AI_USES)), description: z.string().max(2000).optional() })
        .nullable()
        .optional()
        .describe("How AI was used to make the game; uses [] means no AI. generatedGameplay needs a description of what is generated and its guardrails."),
    },
    async (args) => creatorResult(() => setStoreDetails({ ...args, face: "mcp" }))
  );

  server.tool(
    "summer_sync_items",
    "Bring the store game's items in line with summer.items.json in the project root, matched by each item's slug (the creator key the game's code uses, e.g. emote_ponder), so the same file gives the staging game and the production game the same items. First call with confirm=false: it checks the file, reads the game's items by slug and returns the plan (create, update with the changed fields, unchanged, blocked with the reason, and the game's items the file does not name, which are never changed) for the gateway this machine is set to; show it to the user. With confirm=true it uploads the changed images and sends the plan to the game's owner: the answer carries the approval link; nothing changes until the owner approves in Studio, then each item is created or revised, priced in Sparks and submitted for Summer's review. After Summer approves an item, the owner activates it in Studio (Review activation on the item's page); players can buy it only while the game is live. A change to a live item is a new revision, reviewed and activated again. An item with the same slug that is a Passport collectible is blocked: Passport items are not synced. One approval takes at most 50 changed items: a larger plan lists batches, confirm each with slugs. A new item needs at least one image. Never activates or releases an item. Needs \"summer login --store\". Staging or production is the gateway this machine is set to; switching takes SUMMER_GATEWAY_URL and SUMMER_MCP_RESOURCE_URL, then \"summer login --store --force\" (one store sign-in per machine; a sign-in for the other environment fails with store_login_other_environment).",
    {
      gameId: z.string().optional().describe("The store game id on this gateway (from games.list). Staging and production games have different ids. Without it the call fails with game_required and lists your store games."),
      project: z.string().optional().describe("Project folder with project.godot and summer.items.json. Defaults to the MCP's bound project, then the working directory."),
      file: z.string().optional().describe("The items file, relative to the project. Default summer.items.json."),
      slugs: z.array(z.string()).max(500).optional().describe("Only these items (their slugs); the rest of the file is left out of the plan. Confirm a plan of more than 50 changed items one batch (from batches) at a time."),
      confirm: z.boolean().default(false).describe("Set true only after the user approves the plan."),
    },
    async (args) => creatorResult(() => syncItems({ ...args, face: "mcp" }))
  );

  server.tool(
    "summer_content_make",
    "Make one finished, postable piece of content for a game and put it in the team's Review (Studio > Grow > Content), on this computer: it picks the reference from Summer's library that fits today (a format the game has not posted, what changed in the repo), studies its cuts and caption look, measures the footage, maps each reference shot to a clip window with motion, cuts to the reference's timings, draws the captions in its style, mixes at -14 LUFS, checks hook, motion per shot, safe zones, length and loudness, renders the reference side by side, uploads and saves the piece (failed checks: a draft). It never writes words itself: the first call answers needs_words with the beats and the kit's learnings; call again with workDir, lines (one per beat, in the reference's pattern, true to the game, never the reference's own words) and learningIds. A reference that speaks also needs voiceFile, the lines recorded in the team's voice (needs_voice). Same workDir continues where a run stopped. claim=true takes the oldest queued make request instead (nothing_queued when none; a revision answers needs_changes with what the team asked) and reports every stage to it, so Today shows it live. Needs ffmpeg and ImageMagick (and Whisper for a voice-over). Takes a few minutes.",
    {
      contentGameId: z.string().optional().describe("The game's Content id, from content.list_games. Not needed with workDir."),
      teamId: z.string().optional().describe("From team.list, when the person has more than one team."),
      referenceId: z.string().optional().describe("The reference to copy, from content.list_references. Without it the best fit for today is picked."),
      footage: z.array(z.string()).max(20).optional().describe("Folders (or files) of the game's footage on this computer: clips, stills, and the game's music. Default ./content/footage."),
      lines: z.array(z.string()).max(80).optional().describe("Our words, one per reference beat (\"\" for a beat without words), from the needs_words answer."),
      voiceFile: z.string().optional().describe("The lines recorded in the team's voice (wav, mp3, m4a), when the reference speaks."),
      title: z.string().max(100).optional().describe("The piece's title in Review (also the YouTube title)."),
      caption: z.string().max(2200).optional().describe("The post caption: one dry line and a question, no hashtags."),
      hashtags: z.array(z.string()).max(10).optional().describe("3-5 tags, the game's tag first. Default: the kit's core tags."),
      note: z.string().max(2000).optional().describe("What to make it about (\"the new boss\", or commit lines like \"3f2a1c9 Add waiting room\"): weighs the reference pick and becomes the why."),
      claim: z.boolean().optional().describe("Make a queued make request (the daily scheduler's, or a Change pressed on Today) and report every stage to it: the one named by requestId, else the team's oldest."),
      requestId: z.string().optional().describe("The make request to claim, from content.make."),
      learningIds: z.array(z.string()).max(20).optional().describe("The kit learnings (content.get_kit learnings, listed in needs_words) the words and choices applied."),
      workDir: z.string().optional().describe("The work folder an earlier call answered: continues that piece."),
      out: z.string().optional().describe("Where the work goes (pieces, the reference videos and footage measurements). Default ~/.summer/content."),
      music: z.string().optional().describe("The game's own music for a reference with a song (never the reference's audio). Default: the first song in the footage folders."),
      font: z.string().optional().describe("The game's caption font file (.ttf/.otf)."),
      referenceFile: z.string().optional().describe("The reference video, when it cannot be fetched (yt-dlp)."),
      repo: z.string().optional().describe("The game's repo, for what changed today. Default the working directory."),
      stage: z.enum(["plan", "all"]).optional().describe("plan: stop after the plan, to change shots in plan.json."),
      upload: z.boolean().optional().describe("false: render and check only, upload nothing."),
      replan: z.boolean().optional().describe("Throw away the plan and map the shots again."),
      status: z.enum(["draft", "in_review"]).optional().describe("Override: in_review even with failed checks, or draft."),
    },
    async (args) => creatorResult(() => contentMake({ ...contentMakeInput(args as Record<string, unknown>), face: "mcp" }))
  );
}
