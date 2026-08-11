// packages/app-core/src/client/diffFullTexts.ts
// Reconstruct the FULL old/new texts behind a git unified diff, so the diff
// panel's syntax highlighting can tokenize whole files (correct grammar state
// across hunk gaps and SFC block boundaries) instead of stitched fragments.

import type { DiffViewLine } from './types';
import { splitLines } from './diffLines';

/** Both sides' full texts behind a diff, ready to tokenize. */
export interface DiffFullTexts {
  before: string;
  after: string;
}

/** Per-side line cap for full-file tokenization — beyond it shiki's one-off
    cost stops being interactive and callers fall back to fragment mode. */
export const MAX_FULL_DIFF_LINES = 6000;

/** Per-side CHAR cap for tokenization — the line cap alone lets a minified
    one-liner or generated blob through, and shiki's cost is per character:
    a near-read-limit line can stall the UI for seconds (same reasoning as the
    tool cards' MAX_CONTENT_CHARS). */
export const MAX_HIGHLIGHT_CHARS = 256 * 1024;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Hunk range start → 0-based position in that side's lines. A zero-count
// range's number is the line BEFORE the gap (git convention), not a real
// 1-based start.
function hunkTarget(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

/**
 * Reverse-apply parsed diff rows to the current (new-side) file text to
 * recover the pre-diff (old) text. Returns null when the rows don't match
 * `newText` — the file moved on disk after the diff was taken — so callers
 * can fall back to fragment highlighting.
 */
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
      // The unchanged run between hunks exists only in the new text — copy it.
      while (newPtr < newTarget) oldLines.push(newLines[newPtr++]!);
      if (oldLines.length !== oldTarget) return null;
      continue;
    }
    if (row.oldNo === undefined && row.newNo === undefined) {
      // Omission markers (verbatim tool-card rows) can't be reconstructed.
      return null;
    }
    if (row.type === 'del') {
      oldLines.push(row.text);
      continue;
    }
    // context / add rows must match the new side at the cursor.
    if (newPtr >= newLines.length || newLines[newPtr] !== row.text) return null;
    newPtr++;
    if (row.type === 'context') oldLines.push(row.text);
  }
  while (newPtr < newLines.length) oldLines.push(newLines[newPtr++]!);
  return oldLines.join('\n');
}

/**
 * Full texts for one diff-panel file: the new side read from disk (empty for
 * deleted files), the old side reverse-applied from the diff rows. Returns
 * null — callers fall back to fragment highlighting — when the diff was
 * truncated server-side, either side exceeds the tokenization budget, or the
 * working tree moved on between the diff and the read.
 */
export async function buildFullDiffTexts(
  rows: DiffViewLine[],
  opts: {
    truncated: boolean;
    /** Current file text, or null when unreadable (deleted, binary, error). */
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
