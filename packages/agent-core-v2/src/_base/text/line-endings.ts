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

export function dominantLineEnding(text: string): '\r\n' | '\n' | '\r' | undefined {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === 13) {
      if (text.codePointAt(i + 1) === 10) {
        crlf++;
        i++;
      } else {
        cr++;
      }
    } else if (code === 10) {
      lf++;
    }
  }
  if (crlf > lf && crlf > cr) return '\r\n';
  if (lf > crlf && lf > cr) return '\n';
  if (cr > crlf && cr > lf) return '\r';
  return undefined;
}

export function normalizeLineEndings(text: string, eol: '\r\n' | '\n' | '\r'): string {
  return text.replaceAll(/\r\n|\r|\n/g, eol);
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
