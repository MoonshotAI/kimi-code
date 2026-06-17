import {
  fileDiffForPath,
  parseUnifiedDiff,
  type ReviewCommentAnchor,
} from '@moonshot-ai/kimi-code-sdk';

export interface DiffViewRow {
  readonly kind: 'context' | 'add' | 'del';
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

export interface DiffWindow {
  readonly rows: readonly DiffViewRow[];
  /** Row index the comment band attaches under, or -1 when the anchor was not found. */
  readonly anchorIndex: number;
  readonly found: boolean;
}

/**
 * Build a small windowed view of the diff around a comment anchor, for the
 * reader's right pane. Windows within the single hunk that contains the
 * anchor so unrelated hunks never bleed into the view.
 */
export function buildDiffWindow(
  diff: string,
  anchor: Pick<ReviewCommentAnchor, 'path' | 'side' | 'line'>,
  contextLines = 3,
): DiffWindow {
  const file = fileDiffForPath(parseUnifiedDiff(diff), anchor.path);
  if (file === undefined) return { rows: [], anchorIndex: -1, found: false };

  for (const hunk of file.hunks) {
    const rows: DiffViewRow[] = hunk.lines.map((line) => ({
      kind: line.kind,
      oldLine: line.oldLine,
      newLine: line.newLine,
      text: line.text,
    }));
    const index = rows.findIndex((row) =>
      (anchor.side === 'new' ? row.newLine : row.oldLine) === anchor.line,
    );
    if (index !== -1) {
      const start = Math.max(0, index - contextLines);
      const end = Math.min(rows.length, index + contextLines + 1);
      return { rows: rows.slice(start, end), anchorIndex: index - start, found: true };
    }
  }

  // Anchor not in the diff (e.g. file changed since review): show the first hunk.
  const first = file.hunks[0];
  if (first !== undefined) {
    const rows = first.lines.slice(0, contextLines * 2 + 1).map((line) => ({
      kind: line.kind,
      oldLine: line.oldLine,
      newLine: line.newLine,
      text: line.text,
    }));
    return { rows, anchorIndex: -1, found: false };
  }
  return { rows: [], anchorIndex: -1, found: false };
}

export interface FileDiffRow {
  readonly kind: 'context' | 'add' | 'del' | 'hunk';
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

export interface FileDiffView {
  readonly rows: readonly FileDiffRow[];
  /** Index in `rows` of the anchored line, or -1 when not found. */
  readonly anchorIndex: number;
  readonly found: boolean;
  /** Max line-number digit width, for gutter alignment. */
  readonly lineNumberWidth: number;
}

/**
 * Build the full diff of the anchor's file (every hunk, with hunk-header rows),
 * plus the index of the anchored row — for the scrollable full-screen pane.
 */
export function buildFileDiff(
  diff: string,
  anchor: Pick<ReviewCommentAnchor, 'path' | 'side' | 'line'>,
): FileDiffView {
  const file = fileDiffForPath(parseUnifiedDiff(diff), anchor.path);
  if (file === undefined) return { rows: [], anchorIndex: -1, found: false, lineNumberWidth: 1 };

  const rows: FileDiffRow[] = [];
  let anchorIndex = -1;
  let maxLine = 0;
  for (const hunk of file.hunks) {
    rows.push({ kind: 'hunk', text: hunk.header });
    for (const line of hunk.lines) {
      const at = anchor.side === 'new' ? line.newLine : line.oldLine;
      if (line.newLine !== undefined) maxLine = Math.max(maxLine, line.newLine);
      if (line.oldLine !== undefined) maxLine = Math.max(maxLine, line.oldLine);
      if (at === anchor.line && anchorIndex === -1) anchorIndex = rows.length;
      rows.push({ kind: line.kind, oldLine: line.oldLine, newLine: line.newLine, text: line.text });
    }
  }
  return { rows, anchorIndex, found: anchorIndex !== -1, lineNumberWidth: Math.max(1, String(maxLine).length) };
}

/** Format the gutter line-number column for a diff row. */
export function diffGutter(row: DiffViewRow, width: number): string {
  const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
  const number = row.kind === 'del' ? row.oldLine : row.newLine;
  const numberText = number === undefined ? '' : String(number);
  return `${numberText.padStart(width)} ${marker}`;
}
