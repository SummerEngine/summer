import { describe, expect, it } from "vitest";
import { localEntries } from "./catalog.js";
import { shippedCloudEntries } from "./public-catalog.js";
import { searchEntries } from "./search.js";

/**
 * What people type, and the operation that must come first. Where two
 * operations both do the job, either may lead.
 */
const PHRASES: Array<[string, string | string[]]> = [
  ["publish my game", "store.publish"],
  ["make a 3d model", "assets.generate_3d"],
  ["how did my game do", "analytics.summary"],
  ["lower my price", "pricing.set_base"],
  ["raise the price", "pricing.set_base"],
  ["invite a teammate", ["team.invite", "games.invite_member"]],
  ["add multiplayer", "docs.search"],
  ["take a screenshot", "engine.screenshot"],
  ["put my game on sale", "pricing.schedule_discount"],
  ["make a sound effect", ["assets.generate_sfx_choices", "assets.generate_audio"]],
  ["make music for my game", "assets.generate_audio"],
  ["draw a picture", "assets.generate_image"],
  ["make an animation", "assets.generate_motion"],
  ["rig my character", "assets.rig"],
  ["remove the background from an image", "assets.remove_background"],
  ["find a free sword model", "assets.search"],
  ["upload my build", ["store.upload_begin", "store.upload_file"]],
  ["export my game", "engine.export_game"],
  ["run my game", "engine.play"],
  ["stop the game", "engine.stop"],
  ["check if the game is running", "engine.is_running"],
  ["why is my script broken", "engine.get_script_errors"],
  ["what errors does my game have", ["engine.get_diagnostics", "engine.get_debugger_errors"]],
  ["add a node", "engine.add_node"],
  ["how many players do I have", ["analytics.overview", "analytics.summary"]],
  ["how many credits do I have", "whoami"],
  ["who is signed in", "whoami"],
  ["start a new game", "projects.create"],
  ["list my games", "games.list"],
  ["change my store description", "store.update_listing"],
  ["set the cover art", "store.set_art"],
  ["did my game get approved", "store.status"],
  ["write patch notes", "store.update_release_notes"],
  ["enter a game jam", "jams.enter"],
  ["run an a/b test", ["experiments.create", "experiments.start"]],
];

describe("plain-English search over every operation", () => {
  const entries = [...localEntries(), ...shippedCloudEntries()];

  it.each(PHRASES)('"%s" finds %s first', (query, want) => {
    const [first] = searchEntries(entries, query, { limit: 5 });
    expect([want].flat()).toContain(first?.name);
  });

  it("finds an operation by its name or its 3.x name first", () => {
    expect(searchEntries(entries, "store.publish", { limit: 1 })[0].name).toBe("store.publish");
    expect(searchEntries(entries, "summer_store_submit", { limit: 1 })[0].name).toBe("store.publish");
    expect(searchEntries(entries, "summer_add_node", { limit: 1 })[0].name).toBe("engine.add_node");
  });

  it("keeps to an area or an effect when asked", () => {
    expect(searchEntries(entries, "publish my game", { area: "apps", limit: 3 }).every((entry) => entry.name.startsWith("apps."))).toBe(true);
    expect(searchEntries(entries, "price", { effect: "read", limit: 3 }).map((entry) => entry.name)).toContain("pricing.get");
  });
});
