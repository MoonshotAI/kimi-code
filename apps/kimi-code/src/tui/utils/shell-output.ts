import { currentTheme } from '#/tui/theme';
import { readEnvInt } from './transcript-window';

const CSI_PATTERN = /\u001B\[[0-9:;<=>?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const ESC_SINGLE_PATTERN = /\u001B(?:[ -/][0-~]|[0-~])/g;
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001B\u001C-\u001F]/g;

export function sanitizeShellOutput(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length === 0) return text;
  try {
    return text
      .replace(OSC_PATTERN, '')
      .replace(CSI_PATTERN, '')
      .replace(ESC_SINGLE_PATTERN, '')
      .replace(C0_CONTROL_PATTERN, '');
  } catch {
    return text.replace(C0_CONTROL_PATTERN, '');
  }
}

export function formatBashOutputForDisplay(stdout: string, stderr: string, isError?: boolean): string {
  try {
    const dim = (s: string): string => currentTheme.fg('textDim', s);
    const parts: string[] = [];
    const cleanStdout = sanitizeShellOutput(stdout).trimEnd();
    if (cleanStdout.length > 0) parts.push(dim(cleanStdout));
    const cleanStderr = sanitizeShellOutput(stderr).trimEnd();
    if (cleanStderr.length > 0) {
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

/**
 * Cap on each stored stream once a command finishes; the tail is what matters.
 * `KIMI_CODE_TUI_MAX_STORED_CHARS=0` disables the cap and restores the previous
 * full-output view, including Ctrl-O expansion, for users who relied on it.
 */
export const MAX_STORED_STREAM_CHARS = readEnvInt('KIMI_CODE_TUI_MAX_STORED_CHARS', 64 * 1024);

/**
 * Bound a finished command's stored output. The running buffer is already
 * capped mid-stream (see ShellRunComponent), but the final copies used to be
 * stored whole: one inside the component, one formatted into the transcript
 * entry, so a `! cat bigfile` habit grew the session without bound. Keep the
 * tail and say on the first line how much was dropped. `maxChars <= 0` keeps
 * everything.
 */
export function capStoredShellOutput(text: string, maxChars = MAX_STORED_STREAM_CHARS): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  let tail = text.slice(-maxChars);
  // Do not start the kept text on the low half of a surrogate pair.
  const first = tail.codePointAt(0);
  if (first !== undefined && first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  return `… (${text.length - tail.length} earlier chars truncated)\n${tail}`;
}
