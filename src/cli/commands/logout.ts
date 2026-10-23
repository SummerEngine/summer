import { Command } from "commander";
import { clearAuthCredentials, hasEnvAuthToken } from "../../core/auth.js";

export const logoutCommand = new Command("logout")
  .description("Sign out and clear stored auth tokens")
  .action(async () => {
    await runLogout(console.log);
  });

export async function runLogout(log: (message: string) => void): Promise<void> {
  const removed = await clearAuthCredentials();
  if (removed > 0) {
    log("Logged out. Stored auth tokens cleared.");
  } else {
    log("Already logged out (no stored tokens found).");
  }
  if (hasEnvAuthToken()) {
    log(
      "Note: SUMMER_TOKEN is set in this environment and still authenticates gateway calls — logout does not affect it. Unset SUMMER_TOKEN to sign out here."
    );
  }
}
