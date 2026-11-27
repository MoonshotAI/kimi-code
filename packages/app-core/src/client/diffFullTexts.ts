
import type { DiffViewLine } from './types';
import { splitLines } from './diffLines';

export interface DiffFullTexts {
  before: string;
  after: string;
}

export const MAX_FULL_DIFF_LINES = 6000;

export const MAX_HIGHLIGHT_CHARS = 256 * 1024;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function hunkTarget(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

export function reconstructOldText(rows: DiffViewLine[], newText: string): string | null {
  const newLines = splitLines(newText);
  const oldLines: string[] = [];
  let newPtr = 0;
  for (const row of rows) {
    if (row.type === 'hunk') {
      const m = HUNK_RE.exec(row.text);
      if (!m) return null;
      const oldTarget = hunkTarget(Number(m[1]), m[2] === undefined ? 1 : Number(m[2]));
      const newTarget = hunkTarget(Number(m[3]), m[4] === undefined ? 1 : Number(m[4]));
      if (newTarget < newPtr || newTarget > newLines.length) return null;
      while (newPtr < newTarget) oldLines.push(newLines[newPtr++]!);
      if (oldLines.length !== oldTarget) return null;
      continue;
    }
    if (row.oldNo === undefined && row.newNo === undefined) {
      return null;
    }
    if (row.type === 'del') {
      oldLines.push(row.text);
      continue;
    }
    if (newPtr >= newLines.length || newLines[newPtr] !== row.text) return null;
    newPtr++;
    if (row.type === 'context') oldLines.push(row.text);
  }
  while (newPtr < newLines.length) oldLines.push(newLines[newPtr++]!);
  return oldLines.join('\n');
}

export async function buildFullDiffTexts(
  rows: DiffViewLine[],
  opts: {
    truncated: boolean;
    readNewText: () => Promise<string | null>;
  },
): Promise<DiffFullTexts | null> {
  if (opts.truncated || rows.length === 0) return null;
  const after = (await opts.readNewText()) ?? '';
  if (after.length > MAX_HIGHLIGHT_CHARS || splitLines(after).length > MAX_FULL_DIFF_LINES) return null;
  const before = reconstructOldText(rows, after);
  if (before === null) return null;
  if (before.length > MAX_HIGHLIGHT_CHARS || splitLines(before).length > MAX_FULL_DIFF_LINES) return null;
  return { before, after };
}
