const TERMINAL_RESTORE_SEQUENCE = '\u001B[?25h\u001B[?2004l\u001B[<u\u001B[>4;0m';

export function restoreTerminalModes(): void {
  try {
    process.stdin.setRawMode(false);
  } catch {}
  try {
    process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
  } catch {}
}
