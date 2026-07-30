import { Command } from "commander";
import { clearAuthCredentials } from "../lib/auth.js";

export const logoutCommand = new Command("logout")
  .description("Sign out and clear stored auth tokens")
  .action(async () => {
    const removed = await clearAuthCredentials();
    if (removed > 0) {
      console.log("Logged out. Auth tokens cleared.");
    } else {
      console.log("Already logged out (no tokens found).");
    }
  });
