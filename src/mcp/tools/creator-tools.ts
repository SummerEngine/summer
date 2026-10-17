import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureGameplay, type CaptureGameplayInput } from "../../core/capabilities/capture-gameplay.js";
import { exportGame } from "../../core/capabilities/export-game.js";
import { STORE_TARGETS } from "../../core/capabilities/export-presets.js";
import { exportTemplates, TEMPLATE_PLATFORMS } from "../../core/capabilities/export-templates.js";
import { publishBuild } from "../../core/capabilities/publish-build.js";
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
    "Upload an export from summer_export_game to the creator's game on summer.games, through the same store upload Studio uses, straight from disk. A store bundle (format bundle): declare, upload parts, seal, wait until Summer makes the Build, name its client pack, and with publish=true approve it. A web build or native download (format download): upload it as the game's store version for its platform (web, macos-universal, windows-x64, linux-x64; read from the last export) and wait until Summer has checked it. First call with confirm=false: it checks that the game exists for this account and warns when its store page does not list the export's platforms, then returns the target (game name and id, file, digest, size, version) to show the user; set confirm only after they approve. Needs \"summer login --store\". A retry with the same file and clientVersion continues the same upload. Nothing here makes a game live: the owner approves publishing (summer_store_submit).",
    {
      gameId: z.string().optional().describe("The store game id (from summer_store_list_games, or the Studio store page URL). Without it the call fails with game_required and lists your store games, or says why the store did not list them."),
      file: z.string().optional().describe("Exported .zip. Defaults to the last summer_export_game result."),
      clientVersion: z.string().describe("Build version, vMAJOR.MINOR.PATCH (e.g. v1.0.0); a new upload needs a new version."),
      publish: z.boolean().default(false).describe("Bundles only: also approve the Build for players. A game that has not passed review keeps it as a preview; an agent needs the owner's approval."),
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
    "summer_sync_items",
    "Bring the store game's items in line with summer.items.json in the project root, matched by each item's slug (the creator key the game's code uses, e.g. emote_ponder), so the same file gives the staging game and the production game the same items. First call with confirm=false: it checks the file, reads the game's items by slug and returns the plan (create, update with the changed fields, unchanged, blocked with the reason, and the game's items the file does not name, which are never changed) for the gateway this machine is set to; show it to the user. With confirm=true it uploads the changed images and sends the plan to the game's owner: the answer carries the approval link; nothing changes until the owner approves in Studio, then each item is created or revised, priced in Sparks and submitted for Summer's review. One approval takes at most 50 changed items: a larger plan lists batches, confirm each with slugs. A new item needs at least one image. Never activates or releases an item. Needs \"summer login --store\". Staging or production is the gateway this machine is set to; switching takes SUMMER_GATEWAY_URL and SUMMER_MCP_RESOURCE_URL, then \"summer login --store --force\" (one store sign-in per machine; a sign-in for the other environment fails with store_login_other_environment).",
    {
      gameId: z.string().optional().describe("The store game id on this gateway (from summer_store_list_games). Staging and production games have different ids. Without it the call fails with game_required and lists your store games."),
      project: z.string().optional().describe("Project folder with project.godot and summer.items.json. Defaults to the MCP's bound project, then the working directory."),
      file: z.string().optional().describe("The items file, relative to the project. Default summer.items.json."),
      slugs: z.array(z.string()).max(500).optional().describe("Only these items (their slugs); the rest of the file is left out of the plan. Confirm a plan of more than 50 changed items one batch (from batches) at a time."),
      confirm: z.boolean().default(false).describe("Set true only after the user approves the plan."),
    },
    async (args) => creatorResult(() => syncItems({ ...args, face: "mcp" }))
  );

  server.tool(
    "summer_content_make",
    "Make one finished, postable piece of content for a game and put it in the team's Review (Studio > Grow > Content), on this computer: it picks the reference from Summer's library that fits today (a format the game has not posted, what changed in the repo), studies its cuts and caption look, measures the footage, maps each reference shot to a clip window with motion, cuts to the reference's timings, draws the captions in its style, mixes at -14 LUFS, checks hook, motion per shot, safe zones, length and loudness, renders the reference side by side, uploads and saves the piece (failed checks: a draft). It never writes words itself: the first call answers needs_words with the beats; call again with workDir and lines (one per beat, in the reference's pattern, true to the game, never the reference's own words). A reference that speaks also needs voiceFile, the lines recorded in the team's voice (needs_voice says so). Same workDir continues where a run stopped. Needs ffmpeg and ImageMagick (and Whisper for a voice-over). Takes a few minutes.",
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
      note: z.string().max(300).optional().describe("What to clip (\"the new boss\"): weighs the reference pick."),
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
