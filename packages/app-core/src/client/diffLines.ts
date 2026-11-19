
import { diffArrays } from 'diff';
import type { DiffViewLine } from './types';

const MAX_DIFF_CELLS = 1_000_000;

const MAX_DIFF_ROWS = 5000;
export const MAX_TURN_DIFF_CHARS = 1024 * 1024;
const MAX_WHOLE_FILE_DIFF_MS = 200;

export type WholeFileDiffUnavailable =
  | { reason: 'line_limit'; oldLines: number; newLines: number; maxLines: number }
  | { reason: 'timeout'; oldLines: number; newLines: number; timeoutMs: number };

export function splitLines(s: string): string[] {
  if (s === '') return [];
  return s.endsWith('\n') ? s.slice(0, -1).split('\n') : s.split('\n');
}

const NO_TRAILING_NEWLINE = '\u0000';

function appendNoEolSentinel(s: string): string {
  return s === '' || s.endsWith('\n') ? s : `${s}${NO_TRAILING_NEWLINE}`;
}

export function buildWholeFileDiffLines(
  before: string,
  after: string,
  onUnavailable?: (detail: WholeFileDiffUnavailable) => void,
  maxLines = MAX_DIFF_ROWS,
): DiffViewLine[] | null {
  const oldLines = splitLines(appendNoEolSentinel(before));
  const newLines = splitLines(appendNoEolSentinel(after));
  if (oldLines.length > maxLines || newLines.length > maxLines) {
    onUnavailable?.({ reason: 'line_limit', oldLines: oldLines.length, newLines: newLines.length, maxLines });
    return null;
  }

  const changes = diffArrays(oldLines, newLines, { timeout: MAX_WHOLE_FILE_DIFF_MS });
  if (changes === undefined) {
    onUnavailable?.({ reason: 'timeout', oldLines: oldLines.length, newLines: newLines.length, timeoutMs: MAX_WHOLE_FILE_DIFF_MS });
    return null;
  }

  const rows: DiffViewLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const change of changes) {
    for (const line of change.value) {
      const text = line.endsWith(NO_TRAILING_NEWLINE) ? line.slice(0, -1) : line;
      if (change.added) {
        rows.push({ type: 'add', text, newNo: newNo++ });
      } else if (change.removed) {
        rows.push({ type: 'del', text, oldNo: oldNo++ });
      } else {
        rows.push({ type: 'context', text, oldNo: oldNo++, newNo: newNo++ });
      }
    }
  }
  return rows;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function buildDiffLines(before: string, after: string): DiffViewLine[] | null {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) return [];
  if (n > MAX_DIFF_ROWS || m > MAX_DIFF_ROWS) return null;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;

  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
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

const MAX_VERBATIM_SIDE_ROWS = 500;

export function buildVerbatimDiffLines(before: string, after: string): DiffViewLine[] {
  const result: DiffViewLine[] = [];
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const oldKept = Math.min(oldLines.length, MAX_VERBATIM_SIDE_ROWS);
  const newKept = Math.min(newLines.length, MAX_VERBATIM_SIDE_ROWS);
  for (let no = 1; no <= oldKept; no++) {
    result.push({ type: 'del', text: oldLines[no - 1]!, oldNo: no });
  }
  if (oldLines.length > oldKept) {
    result.push({ type: 'context', text: `… ${oldLines.length - oldKept} more lines …` });
  }
  for (let no = 1; no <= newKept; no++) {
    result.push({ type: 'add', text: newLines[no - 1]!, newNo: no });
  }
  if (newLines.length > newKept) {
    result.push({ type: 'context', text: `… ${newLines.length - newKept} more lines …` });
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
