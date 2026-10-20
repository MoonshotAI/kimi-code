export type LineEndingStyle = 'lf' | 'crlf' | 'mixed';

export function makeCarriageReturnsVisible(text: string): string {
  return text.replaceAll('\r', '\\r');
}

export function splitLinesKeepingTerminator(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.codePointAt(i) === 0x0a) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}
