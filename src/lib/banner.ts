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

  function stripAnsi(str: string) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  function pad(str: string, target: number) {
    const visLen = stripAnsi(str).length;
    return str + " ".repeat(Math.max(0, target - visLen));
  }

  const sessionId = Date.now().toString().slice(-6).padEnd(6, ' ');

  // Left column (Sun) fixed 27 width
  const left = [
    pad("", 27),
    pad(`             ${sunC2}|${reset}`, 27),
    pad(`        ${sunC1}\\${reset}    ${sunC2}|${reset}    ${sunC1}/${reset}`, 27),
    pad(`     ${sunC1}.${reset}    ${sunC2}..::.:..${reset}    ${sunC1}.${reset}`, 27),
    pad(`        ${sunC2}.:::"""":::.${reset}`, 27),
    pad(`    ${sunC3}---:::${sunC2}'      '${sunC3}:::---${reset}`, 27),
    pad(`       ${sunC3}:::        :::${reset}`, 27),
    pad(`    ${sunC3}---:::.      .:::---${reset}`, 27),
    pad(`        ${sunC3}':::....:::'${reset}`, 27),
    pad(`     ${sunC1}'${reset}    ${sunC3}''::::''${reset}    ${sunC1}'${reset}`, 27),
    pad(`        ${sunC1}/${reset}    ${sunC3}|${reset}    ${sunC1}\\${reset}`, 27),
    pad(`             ${sunC3}|${reset}`, 27),
    pad("", 27),
    pad("", 27),
    pad("", 27)
  ];

  // Right column fixed 42 width
  const right = [
    pad("", 42),
    pad(`${bold}Available Commands${reset}`, 42),
    pad(`${dim}summer install:${reset} Download the engine`, 42),
    pad(`${dim}summer login:${reset}   Sign in to your account`, 42),
    pad(`${dim}summer create:${reset}  Create a new project`, 42),
    pad(`${dim}summer mcp:${reset}     Start MCP server`, 42),
    pad("", 42),
    pad(`${bold}Available Skills${reset}`, 42),
    pad(`cloud: ${dim}animation, texturing${reset}`, 42),
    pad(`local: ${dim}debugging, 2d, scene${reset}`, 42),
    pad("", 42),
    pad(`${bold}Connected Engine${reset}`, 42),
    pad(`Status:  ${dim}Ready${reset}`, 42),
    pad(`Version: ${dim}Summer Engine v${version}${reset}`, 42),
    pad(`Session: ${dim}summer_${sessionId}${reset}`, 42)
  ];

  const footerLines = [
    pad("", 69),
    pad(`  ${sunC2}summer-engine-cli${reset} · ${dim}local${reset}`, 69),
    pad(`  ${dim}Docs: https://summerengine.com/docs/mcp${reset}`, 69)
  ];

  const title = ` Summer Engine CLI v${version} `;
  const titleLen = stripAnsi(title).length;
  const totalDashes = 69 - titleLen;
  const leftDashes = Math.floor(totalDashes / 2);
  const rightDashes = totalDashes - leftDashes;
  
  const boxTop = `${dim}┌${"─".repeat(leftDashes)}${title}${"─".repeat(rightDashes)}┐${reset}`;
  const boxBottom = `${dim}└${"─".repeat(69)}┘${reset}`;

  const bodyLines = [
    ...left.map((l, i) => `${dim}│${reset}${l}${right[i]}${dim}│${reset}`),
    ...footerLines.map(f => `${dim}│${reset}${f}${dim}│${reset}`)
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
