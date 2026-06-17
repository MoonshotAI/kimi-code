import type { ReviewDiffSide } from './artifact';

/** A single rendered line inside a diff hunk. */
export interface ReviewDiffLine {
  readonly kind: 'context' | 'add' | 'del';
  readonly text: string;
  /** 1-based line number on the old side, if the line exists there. */
  readonly oldLine?: number;
  /** 1-based line number on the new side, if the line exists there. */
  readonly newLine?: number;
}

export interface ReviewDiffHunk {
  /** Raw hunk header, e.g. "@@ -38,6 +38,9 @@ context". */
  readonly header: string;
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly ReviewDiffLine[];
}

export interface ReviewFileDiff {
  /** New-side path (or old path for deletions). */
  readonly path: string;
  readonly oldPath?: string;
  readonly hunks: readonly ReviewDiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff (as produced by `git diff -p`) into per-file hunks.
 * Tolerant of rename/delete/add headers; binary sections are skipped.
 */
export function parseUnifiedDiff(diff: string): readonly ReviewFileDiff[] {
  const files: ReviewFileDiff[] = [];
  const lines = diff.split('\n');

  let current: { path: string; oldPath?: string; hunks: ReviewDiffHunk[] } | undefined;
  let hunk: { header: string; oldStart: number; newStart: number; lines: ReviewDiffLine[] } | undefined;
  let oldLine = 0;
  let newLine = 0;

  const flushHunk = (): void => {
    if (current !== undefined && hunk !== undefined) {
      current.hunks.push({
        header: hunk.header,
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        lines: hunk.lines,
      });
    }
    hunk = undefined;
  };
  const flushFile = (): void => {
    flushHunk();
    if (current !== undefined) {
      files.push({ path: current.path, oldPath: current.oldPath, hunks: current.hunks });
    }
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushFile();
      current = { path: pathFromGitHeader(line), hunks: [] };
      continue;
    }
    if (current === undefined) continue;

    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = stripDiffPath(line.slice(4));
      if (p !== undefined) current.oldPath = p;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripDiffPath(line.slice(4));
      if (p !== undefined) current.path = p;
      continue;
    }

    const match = HUNK_HEADER.exec(line);
    if (match !== null) {
      flushHunk();
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = { header: line, oldStart: oldLine, newStart: newLine, lines: [] };
      continue;
    }
    if (hunk === undefined) continue;

    const marker = line[0];
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: line.slice(1), newLine });
      newLine += 1;
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine });
      oldLine += 1;
    } else if (marker === ' ') {
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
    // '\' (no newline at end of file) and anything else is ignored.
  }
  flushFile();
  return files;
}

/** Find the hunk header covering `line` on the given side, if any. */
export function anchorHunkHeader(
  fileDiff: ReviewFileDiff | undefined,
  side: ReviewDiffSide,
  line: number,
): string | undefined {
  if (fileDiff === undefined) return undefined;
  for (const hunk of fileDiff.hunks) {
    for (const diffLine of hunk.lines) {
      const at = side === 'new' ? diffLine.newLine : diffLine.oldLine;
      if (at === line) return hunk.header;
    }
  }
  return undefined;
}

/** Look up the parsed diff for a path (matches new path or old path). */
export function fileDiffForPath(
  files: readonly ReviewFileDiff[],
  path: string,
): ReviewFileDiff | undefined {
  return files.find((file) => file.path === path || file.oldPath === path);
}

function pathFromGitHeader(line: string): string {
  // "diff --git a/foo b/bar" → prefer the b/ path.
  const rest = line.slice('diff --git '.length);
  const bIndex = rest.lastIndexOf(' b/');
  if (bIndex !== -1) return rest.slice(bIndex + 3);
  return rest;
}

function stripDiffPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '/dev/null') return undefined;
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) return trimmed.slice(2);
  return trimmed;
}
