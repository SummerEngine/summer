import { Command } from "commander";
import { clearAuthCredentials } from "../lib/auth.js";
import { clearPlatformSession } from "../lib/platform-auth.js";

export const logoutCommand = new Command("logout")
  .description("Sign out and clear stored auth tokens")
  .action(async () => {
    const removed =
      (await clearAuthCredentials()) + ((await clearPlatformSession()) ? 1 : 0);
    if (removed > 0) {
      console.log("Logged out. Auth tokens cleared.");
    } else {
      console.log("Already logged out (no tokens found).");
    }
  });
