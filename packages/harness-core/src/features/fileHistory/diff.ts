import type { FileHistoryChange } from './fileHistory';

export interface LcsCellBudget {
  remaining: number;
}

export const LCS_CELL_BUDGET = 4_000_000;
export const LCS_AGGREGATE_CELL_BUDGET = 16_000_000;

export function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  else lines[lines.length - 1] = `${lines.at(-1)!}\u0000`;
  return lines;
}

function countLines(content: string): number {
  return splitLines(content).length;
}

export function countLineDiff(
  before: string,
  after: string,
  budget?: LcsCellBudget,
): { additions: number; deletions: number } | undefined {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }
  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const oldSlice = beforeLines.slice(start, beforeEnd);
  const newSlice = afterLines.slice(start, afterEnd);
  const cells = oldSlice.length * newSlice.length;
  if (cells > LCS_CELL_BUDGET) return undefined;
  if (budget !== undefined) {
    if (cells > budget.remaining) return undefined;
    budget.remaining -= cells;
  }
  const common = lcsLength(oldSlice, newSlice);
  return {
    additions: newSlice.length - common,
    deletions: oldSlice.length - common,
  };
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        a[i - 1] === b[j - 1]
          ? previous[j - 1]! + 1
          : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

export function diffChange(
  path: string,
  beforeBytes: Uint8Array | undefined,
  afterBytes: Uint8Array | undefined,
  budget?: LcsCellBudget,
): FileHistoryChange | undefined {
  if (beforeBytes === undefined && afterBytes === undefined) return undefined;
  const before = beforeBytes === undefined ? undefined : decodeText(beforeBytes);
  const after = afterBytes === undefined ? undefined : decodeText(afterBytes);
  const binary =
    (beforeBytes !== undefined && before === undefined) ||
    (afterBytes !== undefined && after === undefined);

  if (beforeBytes === undefined) {
    return binary
      ? { path, status: 'added', additions: 0, deletions: 0, binary }
      : { path, status: 'added', additions: countLines(after ?? ''), deletions: 0 };
  }
  if (afterBytes === undefined) {
    return binary
      ? { path, status: 'deleted', additions: 0, deletions: 0, binary }
      : { path, status: 'deleted', additions: 0, deletions: countLines(before ?? '') };
  }
  if (binary) {
    return bytesEqual(beforeBytes, afterBytes)
      ? undefined
      : { path, status: 'modified', additions: 0, deletions: 0, binary };
  }
  if (before === after) return undefined;
  const counted = countLineDiff(before ?? '', after ?? '', budget);
  if (counted === undefined) {
    return { path, status: 'modified', additions: 0, deletions: 0, oversize: true };
  }
  return { path, status: 'modified', additions: counted.additions, deletions: counted.deletions };
}
