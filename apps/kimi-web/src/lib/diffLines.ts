// apps/kimi-web/src/lib/diffLines.ts
// Build line-by-line diff rows for <DiffLines/> from a before/after pair of
// plain texts (Edit's old_string/new_string, or Write's content vs an empty
// before). Uses a classic line-level LCS so unchanged lines line up as context.

import type { DiffViewLine } from '../types';

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  // A trailing newline produces a trailing empty element that is not a real
  // content line — drop exactly one of them.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/**
 * Line-level LCS diff between `before` and `after`, producing rows consumable
 * by <DiffLines/>. Line numbers are 1-based and advance per side like a
 * unified diff: context lines advance both, deletions advance old, additions
 * advance new.
 */
export function buildDiffLines(before: string, after: string): DiffViewLine[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) return [];

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] =
        oldLines[i - 1] === newLines[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  type Op = { type: 'context' | 'add' | 'del'; text: string };
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'context', text: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ type: 'add', text: newLines[j - 1]! });
      j--;
    } else {
      ops.push({ type: 'del', text: oldLines[i - 1]! });
      i--;
    }
  }
  ops.reverse();

  const result: DiffViewLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.type === 'context') {
      result.push({ type: 'context', text: op.text, oldNo, newNo });
      oldNo++;
      newNo++;
    } else if (op.type === 'add') {
      result.push({ type: 'add', text: op.text, newNo });
      newNo++;
    } else {
      result.push({ type: 'del', text: op.text, oldNo });
      oldNo++;
    }
  }
  return result;
}

export function diffStats(lines: DiffViewLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}
