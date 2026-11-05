import { currentTheme } from '#/tui/theme';

// Captured command output can contain terminal control sequences — colours,
// cursor moves, alternate-screen switches, hyperlinks, `\r` spinners, bells, …
// We render through pi-tui, which passes strings straight to the terminal, so
// any sequence left intact is executed by the terminal and fights with pi-tui's
// own cursor control (the "blank screen + leftover characters" symptom). Strip
// everything a terminal would interpret as a command rather than printable text,
// keeping only `\n` and `\t` (which the renderer understands).

// ESC [ <params> <intermediates> <final> — colours, cursor moves, clear, and
// private modes such as ESC[?1049h (alt screen) / ESC[?25l (hide cursor).
const CSI_PATTERN = /\u001B\[[0-9:;<=>?]*[ -/]*[@-~]/g;
const ERASE_IN_LINE_PATTERN = /\u001B\[[0-9:;<=>?]*[ -/]*K/g;
const ERASE_IN_LINE_MARKER = '\uE000';
// ESC ] … <BEL>  or  ESC ] … ESC \ — window titles and OSC 8 hyperlinks.
const OSC_PATTERN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
// ESC <char> (and ESC <intermediate> <char>) — charset/keypad selection,
// save/restore cursor (ESC 7 / ESC 8), full reset (ESC c), etc. Runs after the
// CSI/OSC patterns, so it only catches sequences they didn't already consume.
const ESC_SINGLE_PATTERN = /\u001B(?:[ -/][0-~]|[0-~])/g;
// C0 control characters except \n (0x0A), \t (0x09), and \r (0x0D): NUL,
// BEL, \b, … plus a lone ESC (0x1B) that wasn't part of a sequence recognised
// above. Carriage returns are resolved separately because command progress
// redraws use them to overwrite the current line.
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u000C\u000E-\u001B\u001C-\u001F]/g;

function resolveCarriageReturns(text: string): string {
  if (!text.includes('\r') && !text.includes(ERASE_IN_LINE_MARKER)) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r') && !line.includes(ERASE_IN_LINE_MARKER)) return line;
      let out = '';
      let cursor = 0;
      for (let i = 0; i < line.length;) {
        const char = line[i];
        if (char === '\r') {
          cursor = 0;
          i++;
          continue;
        }
        if (char === ERASE_IN_LINE_MARKER) {
          out = out.slice(0, cursor);
          i++;
          continue;
        }
        const nextControl = nextControlIndex(line, i);
        const chunk = line.slice(i, nextControl);
        out = out.slice(0, cursor) + chunk + out.slice(cursor + chunk.length);
        cursor += chunk.length;
        i = nextControl;
      }
      return out;
    })
    .join('\n');
}

function nextControlIndex(line: string, start: number): number {
  let index = start;
  while (index < line.length && line[index] !== '\r' && line[index] !== ERASE_IN_LINE_MARKER) {
    index++;
  }
  return index;
}

/**
 * Strip every terminal control sequence from captured command output so it is
 * safe to render via pi-tui (which does not sanitize on its own).
 *
 * Never throws: a bad or pathological input falls back to stripping only the
 * C0 control characters, so rendering can never crash the TUI.
 */
export function sanitizeShellOutput(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length === 0) return text;
  try {
    const withoutEscapes = text
      .replace(OSC_PATTERN, '')
      .replace(ERASE_IN_LINE_PATTERN, ERASE_IN_LINE_MARKER)
      .replace(CSI_PATTERN, '')
      .replace(ESC_SINGLE_PATTERN, '');
    return resolveCarriageReturns(withoutEscapes)
      .replace(C0_CONTROL_PATTERN, '')
      .replaceAll(ERASE_IN_LINE_MARKER, '');
  } catch {
    return resolveCarriageReturns(text).replace(C0_CONTROL_PATTERN, '').replaceAll(ERASE_IN_LINE_MARKER, '');
  }
}

/**
 * Format captured stdout/stderr for the transcript. Sanitizes both streams and
 * dims them; stderr is red only on actual failure.
 *
 * Never throws: if anything goes wrong (theme lookup, huge input, …) it falls
 * back to a best-effort plain view so a render error can never crash the TUI.
 */
export function formatBashOutputForDisplay(stdout: string, stderr: string, isError?: boolean): string {
  try {
    const dim = (s: string): string => currentTheme.fg('textDim', s);
    const parts: string[] = [];
    const cleanStdout = sanitizeShellOutput(stdout).trimEnd();
    if (cleanStdout.length > 0) parts.push(dim(cleanStdout));
    const cleanStderr = sanitizeShellOutput(stderr).trimEnd();
    if (cleanStderr.length > 0) {
      // Dim grey normally; red only on actual failure (so warnings on a
      // successful command are not mistaken for errors).
      parts.push(isError ? currentTheme.fg('error', cleanStderr) : dim(cleanStderr));
    }
    return parts.length > 0 ? parts.join('\n') : dim('(no output)');
  } catch {
    const plain = [sanitizeShellOutput(String(stdout ?? '')), sanitizeShellOutput(String(stderr ?? ''))]
      .filter((s) => s.length > 0)
      .join('\n');
    return plain.length > 0 ? plain : '(no output)';
  }
}
