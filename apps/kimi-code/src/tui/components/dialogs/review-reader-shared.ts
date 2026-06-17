/**
 * Small rendering helpers shared by the review reader(s). Kept in their own
 * module so they survive independently of any one reader component.
 */

import { Markdown, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { ReviewArtifactComment } from '@moonshot-ai/kimi-code-sdk';

import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';

export const SEVERITY_TAG: Record<ReviewArtifactComment['severity'], string> = {
  critical: '! critical',
  important: '! important',
  minor: '· minor',
};

export function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), length - 1);
}

export function severityColor(severity: ReviewArtifactComment['severity']): (text: string) => string {
  switch (severity) {
    case 'critical':
      return (text) => currentTheme.boldFg('error', text);
    case 'important':
      return (text) => currentTheme.boldFg('warning', text);
    case 'minor':
      return (text) => currentTheme.fg('textMuted', text);
  }
}

/** Render prose through pi-tui Markdown so inline code/bold match the chat. */
export function renderMarkdownLines(text: string, width: number): string[] {
  const rendered = new Markdown(text.trim(), 0, 0, createMarkdownTheme()).render(Math.max(1, width));
  // Drop trailing blank lines the block renderer may emit.
  while (rendered.length > 0 && (rendered.at(-1) ?? '').trim().length === 0) {
    rendered.pop();
  }
  return rendered;
}

export function wrap(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= max) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = visibleWidth(word) <= max ? word : truncateToWidth(word, max, '…');
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
