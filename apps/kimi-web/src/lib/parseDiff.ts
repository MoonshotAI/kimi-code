// apps/kimi-web/src/lib/parseDiff.ts
// Parse raw UNIFIED diff text (git diff output) into line-by-line rows for
// the ~/diff tab. Handles multiple files + multiple hunks per file.

import type { DiffViewLine } from '../types';

/**
 * Lines that introduce file-level metadata. They appear BEFORE the first
 * `@@` hunk of each file and must never be treated as diff content — the
 * file list already names the file, so we only show the actual line changes.
 */
function isFileHeader(line: string): boolean {
  return (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file mode') ||
    line.startsWith('deleted file mode') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('dissimilarity index') ||
    line.startsWith('rename from') ||
    line.startsWith('rename to') ||
    line.startsWith('copy from') ||
    line.startsWith('copy to') ||
    line.startsWith('Binary files')
  );
}

/**
 * Parse a unified diff string into `DiffViewLine[]`.
 *
 * Line numbers are tracked from each `@@ -oldStart,oldLen +newStart,newLen @@`
 * hunk header: context lines advance both counters, deletions advance the old
 * counter, additions advance the new counter. The `\ No newline at end of
 * file` marker is skipped.
 */
export function parseDiff(diff: string): DiffViewLine[] {
  const lines: DiffViewLine[] = [];
  if (!diff) return lines;

  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    // A new file's header always ends the previous file's hunk run, even if
    // we were mid-hunk (git emits no blank separator between files).
    if (isFileHeader(raw)) {
      inHunk = false;
      continue;
    }

    // Hunk header: `@@ -a,b +c,d @@ optional section heading`
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldNo = Number.parseInt(m[1]!, 10);
        newNo = Number.parseInt(m[2]!, 10);
      }
      inHunk = true;
      lines.push({ type: 'hunk', text: raw });
      continue;
    }

    // Before the first hunk of a file, lines are headers we don't recognize
    // explicitly → skip them too.
    if (!inHunk) continue;

    // `\ No newline at end of file` — a git marker, not a content line.
    if (raw.startsWith('\\')) continue;

    const marker = raw.charAt(0);
    const text = raw.slice(1);

    if (marker === '+') {
      lines.push({ type: 'add', text, newNo });
      newNo += 1;
    } else if (marker === '-') {
      lines.push({ type: 'del', text, oldNo });
      oldNo += 1;
    } else if (marker === ' ') {
      lines.push({ type: 'context', text, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
    // Anything else inside a hunk (e.g. a trailing empty line from the split)
    // is ignored.
  }

  return lines;
}
