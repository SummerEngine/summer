export function getBanner(version?: string): string {
  const reset = "\x1b[0m";
  
  // Vertical gradient for SUMMER ENGINE
  const colors = [
    "\x1b[38;2;255;223;137m", // row 1
    "\x1b[38;2;255;203;107m", // row 2
    "\x1b[38;2;255;183;78m",  // row 3
    "\x1b[38;2;255;163;49m",  // row 4
    "\x1b[38;2;255;143;23m",  // row 5
    "\x1b[38;2;255;123;0m",   // row 6
    "\x1b[38;2;242;104;0m",   // row 7
    "\x1b[38;2;229;85;0m",    // row 8
    "\x1b[38;2;215;67;0m",    // row 9
    "\x1b[38;2;201;50;0m",    // row 10
    "\x1b[38;2;187;34;0m",    // row 11
    "\x1b[38;2;173;20;0m",    // row 12
  ];

  const headerLines = [
    "      ██████╗ ██╗   ██╗███╗   ███╗███╗   ███╗███████╗██████╗ ",
    "     ██╔════╝ ██║   ██║████╗ ████║████╗ ████║██╔════╝██╔══██╗",
    "     ███████╗ ██║   ██║██╔████╔██║██╔████╔██║█████╗  ██████╔╝",
    "     ╚════██║ ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══╝  ██╔══██╗",
    "     ███████║ ╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║███████╗██║  ██║",
    "     ╚══════╝  ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝",
    "      ███████╗███╗   ██╗ ██████╗ ██╗███╗   ██╗███████╗       ",
    "      ██╔════╝████╗  ██║██╔════╝ ██║████╗  ██║██╔════╝       ",
    "      █████╗  ██╔██╗ ██║██║  ███╗██║██╔██╗ ██║█████╗         ",
    "      ██╔══╝  ██║╚██╗██║██║   ██║██║██║╚██╗██║██╔══╝         ",
    "      ███████╗██║ ╚████║╚██████╔╝██║██║ ╚████║███████╗       ",
    "      ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝╚═╝  ╚═══╝╚══════╝       ",
  ];

  return headerLines.map((line, i) => `${colors[i]}${line}${reset}`).join("\n");
}

export function getWelcome(version: string): string {
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";

  const sunC1 = "\x1b[38;2;255;223;137m"; // Light yellow
  const sunC2 = "\x1b[38;2;255;163;49m";  // Orange
  const sunC3 = "\x1b[38;2;229;85;0m";    // Red-orange

  const verString = version.padEnd(5, " ");
  const boxTop = `${dim}┌───────────────────────── Summer CLI v${verString} ────────────────────────┐${reset}`;
  const boxBottom = `${dim}└────────────────────────────────────────────────────────────────────┘${reset}`;

  const sessionId = Date.now().toString().slice(-6).padEnd(6, ' ');

  const bodyLines = [
    `${dim}│${reset}                                                                    ${dim}│${reset}`,
    `${dim}│${reset}             ${sunC2}|${reset}             ${bold}Available Commands${reset}                       ${dim}│${reset}`,
    `${dim}│${reset}        ${sunC1}\\${reset}    ${sunC2}|${reset}    ${sunC1}/${reset}        ${dim}summer install:${reset} Download the engine      ${dim}│${reset}`,
    `${dim}│${reset}     ${sunC1}.${reset}    ${sunC2}..::.:..${reset}    ${sunC1}.${reset}    ${dim}summer login:${reset}   Sign in to your account  ${dim}│${reset}`,
    `${dim}│${reset}        ${sunC2}.:::"""":::.${reset}       ${dim}summer create:${reset}  Create a new project     ${dim}│${reset}`,
    `${dim}│${reset}    ${sunC3}---:::${sunC2}'      '${sunC3}:::---${reset}   ${dim}summer mcp:${reset}     Start MCP server         ${dim}│${reset}`,
    `${dim}│${reset}       ${sunC3}:::        :::${reset}                                               ${dim}│${reset}`,
    `${dim}│${reset}    ${sunC3}---:::.      .:::---${reset}   ${bold}Connected Engine${reset}                         ${dim}│${reset}`,
    `${dim}│${reset}        ${sunC3}':::....:::'${reset}       Status: ${dim}Ready${reset}                            ${dim}│${reset}`,
    `${dim}│${reset}     ${sunC1}'${reset}    ${sunC3}''::::''${reset}    ${sunC1}'${reset}    Version: ${dim}Godot 4.5 C++ Fork${reset}               ${dim}│${reset}`,
    `${dim}│${reset}        ${sunC1}/${reset}    ${sunC3}|${reset}    ${sunC1}\\${reset}        Path: ${dim}./${reset}                                 ${dim}│${reset}`,
    `${dim}│${reset}             ${sunC3}|${reset}                                                      ${dim}│${reset}`,
    `${dim}│${reset}                           ${bold}Session Info${reset}                             ${dim}│${reset}`,
    `${dim}│${reset}                           ID: ${dim}summer_${sessionId}${reset}                           ${dim}│${reset}`,
    `${dim}│${reset}                                                                    ${dim}│${reset}`,
    `${dim}│${reset}  ${sunC2}summer-cli${reset} · ${dim}local${reset}                                                ${dim}│${reset}`,
    `${dim}│${reset}  ${dim}Docs: https://summerengine.com/docs${reset}                               ${dim}│${reset}`
  ];

  return [
    "",
    getBanner(),
    "",
    boxTop,
    ...bodyLines,
    boxBottom,
    "",
    `⚠️  ${dim}Some tools disabled (missing engine connection):${reset}`,
    `• Scene Operations ${dim}(needs running editor instance)${reset}`,
    `Run '${bold}summer mcp${reset}' to connect.`,
    "",
    `Welcome to Summer CLI! Type your message or /help for commands.`,
    ""
  ].join("\n");
}

export function printBanner(version?: string): void {
  console.log(getBanner(version));
}

export function printWelcome(version: string): void {
  console.log(getWelcome(version));
}
