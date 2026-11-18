export interface TerminalPreviewScreen {
  lines: string[];
  cursorRow: number;
  cursorColumn: number;
}

export function terminalPreviewScreen(columns: number, rows: number): TerminalPreviewScreen {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, Math.floor(rows));
  const fit = (text: string) => text.length <= width ? text : text.slice(0, width - 1) + '…';
  const paint = (text: string, style: string) => `\x1b[${style}m${text}\x1b[0m`;
  const pair = (left: string, right: string) => left.length + right.length + 1 <= width
    ? left.padEnd(width - right.length) + right : fit(left);
  const heading = paint(pair('Kimi Code', '/help'), '1;34');
  const directory = paint(fit(width >= 36 ? 'Directory: /Users/moon/moon-landing' : '~/moon-landing'), '90');
  const status = paint(width >= 46
    ? pair('Kimi K3.1 Pro thinking: max', 'context: 0% (0/1M)')
    : pair('Kimi K3.1 Pro · max', '0%'), '90');
  const prompt = fit('> ');
  if (height === 1) return { lines: [heading], cursorRow: 1, cursorColumn: width };
  if (height === 2) return { lines: [heading, prompt], cursorRow: 2, cursorColumn: Math.min(3, width) };
  if (height <= 4 || width < 6) {
    const lines = height >= 4 ? [heading, directory, prompt, status] : [heading, prompt, status];
    return { lines, cursorRow: lines.length - 1, cursorColumn: Math.min(3, width) };
  }
  const top = paint('╭' + '─'.repeat(width - 2) + '╮', '90');
  const input = paint('│', '90') + ' >'.padEnd(width - 2) + paint('│', '90');
  const bottom = paint('╰' + '─'.repeat(width - 2) + '╯', '90');
  const lines = height >= 6 ? [heading, directory, top, input, bottom, status] : [heading, top, input, bottom, status];
  return { lines, cursorRow: lines.length - 2, cursorColumn: 4 };
}
