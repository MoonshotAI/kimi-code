import { currentTheme } from '#/tui/theme';

// Strip ANSI/CSI escape sequences (colours, cursor moves, …). Command output
// is run with NO_COLOR=1, but some tools ignore it; stripping keeps the live
// "running" view uniformly dim instead of leaking the tool's own colours.
const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function formatBashOutputForDisplay(stdout: string, stderr: string, isError?: boolean): string {
  const dim = (s: string): string => currentTheme.fg('textDim', s);
  const parts: string[] = [];
  if (stdout.trimEnd().length > 0) parts.push(dim(stdout.trimEnd()));
  if (stderr.trimEnd().length > 0) {
    const err = stderr.trimEnd();
    // Dim grey normally; red only on actual failure (so warnings on a
    // successful command are not mistaken for errors).
    parts.push(isError ? currentTheme.fg('error', err) : dim(err));
  }
  return parts.length > 0 ? parts.join('\n') : dim('(no output)');
}
