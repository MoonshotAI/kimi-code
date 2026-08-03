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
