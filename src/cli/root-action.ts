/**
 * Root `summer` invocation. Commander routes an unknown subcommand
 * (`summer bogus`) to the program action with the stray word as an operand,
 * so a bare-intro action would print the banner and exit 0. Agents probe
 * commands by exit code — an unknown command must fail.
 */
export function runRootAction(operands: readonly string[], printIntro: () => void): void {
  if (operands.length > 0) {
    console.error(`error: unknown command '${operands[0]}'`);
    console.error("Run 'summer --help' to see the available commands.");
    process.exitCode = 1;
    return;
  }
  printIntro();
}
