/**
 * Best-effort terminal restoration for crash / emergency-exit paths.
 *
 * The normal shutdown path goes through pi-tui's `TUI.stop()`, which restores
 * raw mode, the cursor, bracketed paste, and the Kitty / modifyOtherKeys
 * keyboard protocols. When we bail out without running `TUI.stop()` — an
 * uncaught exception, a SIGTERM whose cleanup throws, or a SIGHUP — the
 * terminal would otherwise be left stuck in raw mode with a hidden cursor, and
 * the user's shell would look broken afterwards. Writing these sequences lets
 * the terminal recover.
 *
 * Every step is wrapped: the terminal may already be dead (EIO), and an exit
 * path must never throw.
 */

// Show cursor (`?25h`), disable bracketed paste (`?2004l`), pop the Kitty
// keyboard protocol (`<u`), and reset modifyOtherKeys (`>4;0m`).
const TERMINAL_RESTORE_SEQUENCE = '\u001B[?25h\u001B[?2004l\u001B[<u\u001B[>4;0m';

export function restoreTerminalModes(): void {
  try {
    process.stdin.setRawMode(false);
  } catch {
    // ignore — raw mode may not be active, or stdin may not be a TTY.
  }
  try {
    process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
  } catch {
    // ignore — the terminal may already be dead (EIO).
  }
}
