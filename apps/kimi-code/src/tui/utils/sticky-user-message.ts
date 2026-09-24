import type { TranscriptEntryKind } from '../types';

export interface StickyJudgmentEntry {
  kind: TranscriptEntryKind | undefined;
  bullet?: string;
  content: string;
  height: number;
  contentOffset?: number;
  lineHeights: number[];
}

export interface StickyUserMessageJudgment {
  index: number;
  summary: string;
  targetY: number;
}

export function summarizeStickyUserMessage(content: string, lineCount = 1): string {
  const lines = content.split(/\r?\n/);
  let first = 0;
  while (first < lines.length && lines[first]!.trim() === '') first++;
  return lines
    .slice(first, first + Math.max(1, lineCount))
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function countScrolledOutLines(lineHeights: number[], rowsOut: number): number {
  let rows = 0;
  let count = 0;
  for (const height of lineHeights) {
    const lineRows = Math.max(1, height);
    if (rows + lineRows > rowsOut) break;
    rows += lineRows;
    count++;
  }
  return Math.max(1, count);
}

export function judgeStickyUserMessage(input: {
  entries: readonly StickyJudgmentEntry[];
  scrollTop: number;
  following: boolean;
}): StickyUserMessageJudgment | null {
  const { entries, scrollTop, following } = input;
  if (scrollTop <= 0) return null;
  let y = 0;
  let latest: StickyUserMessageJudgment | null = null;
  let pinned: StickyUserMessageJudgment | null = null;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const entryY = y;
    const height = Math.max(0, entry.height);
    y += height;
    if (entry.kind !== 'user' || entry.bullet === '') continue;
    const summary = summarizeStickyUserMessage(entry.content);
    if (summary === '') continue;
    const offset = Math.min(Math.max(0, entry.contentOffset ?? 0), height);
    const firstLineY = entryY + offset;
    const judgment = { index, summary, targetY: firstLineY + 1 };
    latest = judgment;
    if (firstLineY < scrollTop) {
      judgment.summary = summarizeStickyUserMessage(
        entry.content,
        countScrolledOutLines(entry.lineHeights, scrollTop - firstLineY),
      );
      pinned = judgment;
    }
  }
  if (following) return pinned !== null && pinned === latest ? pinned : null;
  return pinned;
}
