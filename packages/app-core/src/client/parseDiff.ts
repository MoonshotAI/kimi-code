
import type { DiffViewLine } from './types';

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

export function parseDiff(diff: string): DiffViewLine[] {
  const lines: DiffViewLine[] = [];
  if (!diff) return lines;

  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    if (!inHunk && isFileHeader(raw)) continue;

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

    if (!inHunk) continue;

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
  }

  return lines;
}
