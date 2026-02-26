import { Command } from "commander";
import { unlink } from "fs/promises";
import { join } from "path";
import { getSummerDir } from "../lib/auth.js";

export const logoutCommand = new Command("logout")
  .description("Sign out and clear stored auth tokens")
  .action(async () => {
    const dir = getSummerDir();
    const files = ["auth-token", "user.json"];

    let cleared = false;
    for (const file of files) {
      try {
        await unlink(join(dir, file));
        cleared = true;
      } catch {
        // File doesn't exist, that's fine
      }
    }

    if (cleared) {
      console.log("Logged out. Auth tokens cleared.");
    } else {
      console.log("Already logged out (no tokens found).");
    }
  });
