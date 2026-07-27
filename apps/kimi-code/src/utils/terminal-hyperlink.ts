export function toTerminalHyperlink(text: string, url: string): string {
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}

/**
 * Terminals known to lack OSC 8 hyperlink support. Warp renders the
 * sequence as styled-but-inert text (underlined, yet clicks go nowhere),
 * which is worse than printing the URL outright — its own URL detection
 * makes a visible URL clickable. Everywhere else OSC 8 either works or
 * degrades to plain text harmlessly, so this denylist stays short.
 */
const OSC8_UNSUPPORTED_TERM_PROGRAMS = new Set(['WarpTerminal']);

/**
 * Best-effort detection of OSC 8 hyperlink support, driven off well-known
 * environment variables like the OSC 9 checks in
 * `#/tui/utils/terminal-notification`.
 */
export function supportsOsc8Hyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
  return !OSC8_UNSUPPORTED_TERM_PROGRAMS.has(env['TERM_PROGRAM'] ?? '');
}
