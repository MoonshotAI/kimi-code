/**
 * DiffPanelComponent — renders `git diff` output in a bordered panel with
 * theme-aware colouring for added/removed/context/meta lines.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

const LEFT_MARGIN = 2;
const SIDE_PADDING = 1;
const BOX_OVERHEAD = LEFT_MARGIN + 2 + 2 * SIDE_PADDING;

export function buildDiffPanelLines(diffOutput: string): string[] {
  const raw = diffOutput.trimEnd();
  if (raw.length === 0) {
    return [currentTheme.fg('textDim', 'No changes.')];
  }

  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    lines.push(colorizeDiffLine(line));
  }
  return lines;
}

function colorizeDiffLine(line: string): string {
  const theme = currentTheme;

  // Hunk header.
  if (line.startsWith('@@') && line.includes('@@')) {
    return theme.fg('diffGutter', line);
  }
  if (line.startsWith('+')) {
    return theme.fg('diffAdded', line);
  }
  if (line.startsWith('-')) {
    return theme.fg('diffRemoved', line);
  }
  // Git metadata lines: diff header, file paths, mode/rename/similarity info.
  if (/^(diff |index |--- |\+\+\+|rename |similarity |new |deleted |old |\\)/.test(line)) {
    return theme.fg('diffMeta', line);
  }
  return line;
}

export class DiffPanelComponent implements Component {
  /** Cached coloured lines; rebuilt from `buildLines` on every invalidate. */
  private lines: readonly string[];

  constructor(private readonly buildLines: () => readonly string[]) {
    this.lines = buildLines();
  }

  invalidate(): void {
    // Diff bodies embed palette colours, so a theme switch must re-run the
    // builder to repaint the cached lines.
    this.lines = this.buildLines();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const paint = (s: string) => currentTheme.fg('diffGutter', s);
    const availableInterior = safeWidth - BOX_OVERHEAD;
    if (availableInterior < 1) {
      return [
        truncateToWidth('Diff', safeWidth, '…'),
        ...this.lines.map((line) => truncateToWidth(line, safeWidth, '…')),
      ];
    }

    const indent = ' '.repeat(LEFT_MARGIN);
    const longestLine = this.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    const contentWidth = Math.max(
      1,
      Math.min(availableInterior, Math.max(longestLine, visibleWidth(' Diff '))),
    );
    const horzLen = contentWidth + 2 * SIDE_PADDING;
    const title = truncateToWidth(' Diff ', horzLen, '…');

    const trailingDashLen = Math.max(0, horzLen - visibleWidth(title));
    const top =
      indent + paint('╭') + paint(title) + paint('─'.repeat(trailingDashLen)) + paint('╮');
    const bottom = indent + paint('╰' + '─'.repeat(horzLen) + '╯');

    const out: string[] = [top];
    for (const line of this.lines) {
      const clipped = visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth) : line;
      const pad = Math.max(0, contentWidth - visibleWidth(clipped));
      out.push(indent + paint('│') + ' ' + clipped + ' '.repeat(pad) + ' ' + paint('│'));
    }
    out.push(bottom);
    return out.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
