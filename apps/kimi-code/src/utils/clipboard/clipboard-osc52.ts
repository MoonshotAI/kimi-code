const ESC = '\u001B';
const BEL = '\u0007';
const ST = '\\';

function isInsideTmux(): boolean {
  return (process.env['TMUX'] ?? '').length > 0;
}

/**
 * Build an OSC 52 sequence that asks the terminal emulator to put `text` on
 * the system clipboard. The sequence reaches the *local* clipboard through
 * stdout alone, so it keeps working over SSH and inside containers where no
 * native clipboard tool exists. Terminals without OSC 52 support silently
 * ignore it.
 *
 * tmux swallows bare OSC sequences, so inside tmux the sequence is wrapped in
 * a DCS passthrough with doubled ESC bytes (same convention as
 * `buildTerminalNotificationSequences`).
 */
export function buildClipboardOSC52(text: string, insideTmux = isInsideTmux()): string {
  const payload = Buffer.from(text, 'utf8').toString('base64');
  const sequence = `${ESC}]52;c;${payload}${BEL}`;
  if (!insideTmux) return sequence;
  const escaped = sequence.replaceAll(ESC, `${ESC}${ESC}`);
  return `${ESC}Ptmux;${escaped}${ESC}${ST}`;
}

/**
 * Write the OSC 52 sequence to stdout. Returns false when stdout is not a
 * terminal (the sequence would pollute piped output) or the write failed.
 */
export function writeClipboardOSC52(text: string): boolean {
  if (!process.stdout.isTTY) return false;
  try {
    process.stdout.write(buildClipboardOSC52(text));
    return true;
  } catch {
    return false;
  }
}
