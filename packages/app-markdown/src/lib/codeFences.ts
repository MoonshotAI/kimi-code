export interface CodeFence {
  start: number;
  end: number;
  info: string;
  contentStart: number;
  contentEnd: number;
}

export function* codeFences(text: string): Generator<CodeFence> {
  let opening: { start: number; marker: string; length: number; info: string; contentStart: number } | undefined;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    const match = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (match) {
      const marker = match[2]![0]!;
      const length = match[2]!.length;
      const info = match[3]!.trim();
      if (opening) {
        if (marker === opening.marker && length >= opening.length && info === '') {
          yield { start: opening.start, end, info: opening.info, contentStart: opening.contentStart, contentEnd: Math.max(opening.contentStart, start - 1) };
          opening = undefined;
        }
      } else if (newline !== -1 && (marker !== '`' || !info.includes('`'))) {
        opening = { start, marker, length, info, contentStart: end + 1 };
      }
    }
    start = end + 1;
  }
}

export type MarkdownSegment = { kind: 'md'; text: string } | { kind: 'diff'; code: string };

export function splitDiffFences(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  for (const fence of codeFences(text)) {
    if (!/^diff\b/.test(fence.info)) continue;
    const before = text.slice(cursor, fence.start);
    if (before.trim()) segments.push({ kind: 'md', text: before });
    segments.push({ kind: 'diff', code: text.slice(fence.contentStart, fence.contentEnd) });
    cursor = fence.end;
  }
  const tail = text.slice(cursor);
  if (tail.trim() || segments.length === 0) segments.push({ kind: 'md', text: tail });
  return segments;
}
