const HYPERLINK_TERM_PROGRAMS = new Set([
  'iTerm.app',
  'WezTerm',
  'vscode',
  'ghostty',
  'WarpTerminal',
  'Hyper',
]);
const HYPERLINK_TERMS = new Set(['xterm-kitty', 'xterm-ghostty', 'wezterm', 'foot', 'contour']);

export function supportsHyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
  const force = env['FORCE_HYPERLINK'];
  if (force !== undefined) return force !== '0';
  if ((env['WT_SESSION'] ?? '').length > 0) return true;
  if (HYPERLINK_TERM_PROGRAMS.has(env['TERM_PROGRAM'] ?? '')) return true;
  if (HYPERLINK_TERMS.has(env['TERM'] ?? '')) return true;
  if (Number(env['VTE_VERSION'] ?? '0') >= 5000) return true;
  if ((env['KONSOLE_VERSION'] ?? '').length > 0) return true;
  return false;
}

export function toTerminalHyperlink(text: string, url: string): string {
  return `]8;;${url}${text}]8;;`;
}
