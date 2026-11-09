import { Command } from "commander";
import { getStoreAccessToken, OAuthError } from "../../core/oauth.js";

/**
 * `summer token`: print the Summer sign-in's current access token (Supabase
 * OAuth, about one hour; refreshed first when it is about to expire), for
 * curl against the Summer API:
 *
 *   curl -H "Authorization: Bearer $(summer token)" https://www.summerengine.com/v1/models
 *
 * Only the token goes to stdout; a missing sign-in says so on stderr and exits 1.
 */

export interface TokenCommandDependencies {
  token: () => Promise<string>;
  print: (line: string) => void;
  printError: (line: string) => void;
}

const defaults = (): TokenCommandDependencies => ({
  token: () => getStoreAccessToken(),
  print: (line) => process.stdout.write(`${line}\n`),
  printError: (line) => console.error(line),
});

export async function runTokenCommand(overrides: Partial<TokenCommandDependencies> = {}): Promise<number> {
  const deps = { ...defaults(), ...overrides };
  try {
    deps.print(await deps.token());
    return 0;
  } catch (error) {
    deps.printError(error instanceof OAuthError ? 'This computer is not signed in to Summer. Run "summer login", then retry.' : error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export const tokenCommand = new Command("token")
  .description("Print a one-hour Summer API access token from this computer's Summer sign-in (summer login), for curl: Authorization: Bearer $(summer token)")
  .action(async () => {
    const code = await runTokenCommand();
    if (code) process.exitCode = code;
  });
