const ESC = '\u001B';
const BEL = '\u0007';
const ST = '\\';

function isInsideTmux(): boolean {
  return (process.env['TMUX'] ?? '').length > 0;
}

export function buildClipboardOSC52(text: string, insideTmux = isInsideTmux()): string {
  const payload = Buffer.from(text, 'utf8').toString('base64');
  const sequence = `${ESC}]52;c;${payload}${BEL}`;
  if (!insideTmux) return sequence;
  const escaped = sequence.replaceAll(ESC, `${ESC}${ESC}`);
  return `${sequence}${ESC}Ptmux;${escaped}${ESC}${ST}`;
}

export function writeClipboardOSC52(text: string): boolean {
  if (!process.stdout.isTTY) return false;
  try {
    process.stdout.write(buildClipboardOSC52(text));
    return true;
  } catch {
    return false;
  }
}
