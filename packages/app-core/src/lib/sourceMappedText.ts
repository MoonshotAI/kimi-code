export interface TextReplacement {
  start: number;
  end: number;
  text?: string;
}

export interface SourceMappedText {
  source: string;
  text: string;
  starts: readonly number[];
  ends: readonly number[];
}

export function replaceWithSourceMap(
  source: string,
  replacements: ReadonlyArray<TextReplacement> = [],
): SourceMappedText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  const keep = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      text += source[i];
      starts.push(i);
      ends.push(i + 1);
    }
  };
  let cursor = 0;
  for (const replacement of [...replacements].sort((a, b) => a.start - b.start)) {
    const start = Math.min(Math.max(replacement.start, cursor), source.length);
    const end = Math.min(Math.max(replacement.end, start), source.length);
    keep(cursor, start);
    const inserted = replacement.text ?? '';
    for (let i = 0; i < inserted.length; i += 1) {
      text += inserted[i];
      starts.push(start);
      ends.push(end);
    }
    cursor = end;
  }
  keep(cursor, source.length);
  return { source, text, starts, ends };
}

export function trimSpans(source: string): TextReplacement[] {
  const start = source.length - source.trimStart().length;
  const end = Math.max(start, source.trimEnd().length);
  return [{ start: 0, end: start }, { start: end, end: source.length }];
}

export function sourceOffsetAt(mapped: SourceMappedText, offset: number): number {
  if (offset < mapped.starts.length) return mapped.starts[offset]!;
  return mapped.ends.length > 0 ? mapped.ends[mapped.ends.length - 1]! : mapped.source.length;
}

export function sourceOffsetAfter(mapped: SourceMappedText, offset: number): number {
  if (offset > 0 && offset <= mapped.ends.length) return mapped.ends[offset - 1]!;
  return offset <= 0 ? sourceOffsetAt(mapped, 0) : mapped.source.length;
}
