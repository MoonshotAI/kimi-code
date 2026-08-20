export type LineEndingStyle = 'lf' | 'crlf' | 'mixed';

export interface ModelTextView {
  text: string;
  lineEndingStyle: LineEndingStyle;
}

export function detectLineEndingStyle(text: string): LineEndingStyle {
  let hasCrLf = false;
  let hasLf = false;
  let hasLoneCr = false;

  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === 13) {
      if (text.codePointAt(i + 1) === 10) {
        hasCrLf = true;
        i++;
      } else {
        hasLoneCr = true;
      }
    } else if (code === 10) {
      hasLf = true;
    }
  }

  if (hasLoneCr || (hasCrLf && hasLf)) return 'mixed';
  if (hasCrLf) return 'crlf';
  return 'lf';
}

export function toModelTextView(raw: string): ModelTextView {
  const lineEndingStyle = detectLineEndingStyle(raw);
  if (lineEndingStyle !== 'crlf') {
    return { text: raw, lineEndingStyle };
  }

  return {
    text: raw.replaceAll('\r\n', '\n'),
    lineEndingStyle,
  };
}

export function materializeModelText(text: string, lineEndingStyle: LineEndingStyle): string {
  if (lineEndingStyle !== 'crlf') return text;
  return text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
}

export function makeCarriageReturnsVisible(text: string): string {
  return text.replaceAll('\r', '\\r');
}

/**
 * Split text into lines, keeping each line's trailing `\n` (the final line
 * may lack one). Same semantics as Python's `str.splitlines(keepends=True)`
 * restricted to `\n` boundaries.
 */
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
