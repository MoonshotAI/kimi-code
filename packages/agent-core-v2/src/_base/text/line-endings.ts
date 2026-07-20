/**
 * `_base` text helpers — model-text line-ending normalization.
 *
 * Shared low-level helpers used by both the os file tools (Read, to render
 * carriage returns visibly) and the agent edit domain (TextModel, to normalize
 * CRLF → LF for matching and re-materialize on write). Lives in `_base` so
 * higher domains can import it without creating an upward dependency on the os
 * tool implementations.
 *
 * Ported from v1 (`packages/agent-core/src/tools/builtin/file/line-endings.ts`).
 * Normalizes CRLF → LF for display and re-materializes CRLF on write, so the
 * model sees a consistent view while the on-disk bytes stay faithful.
 */

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
