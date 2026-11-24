const INLINE_ATTACHMENT_DESTINATION = '](kimi-code-composer://attachments/';

function maskImageSpans(text: string): string {
  if (!text.includes('![')) return text;
  const brackets: number[] = [];
  const parentheses: number[] = [];
  const closes = new Map<number, number>();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') brackets.push(i);
    else if (ch === '(') parentheses.push(i);
    else if (ch === ']' || ch === ')') {
      const start = (ch === ']' ? brackets : parentheses).pop();
      if (start !== undefined) closes.set(start, i);
    }
  }
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] !== '!' || text[i + 1] !== '[') continue;
    const altClose = closes.get(i + 1);
    if (altClose === undefined || text[altClose + 1] !== '(') continue;
    const destClose = closes.get(altClose + 1);
    if (destClose === undefined) continue;
    parts.push(text.slice(cursor, i), ' '.repeat(destClose + 1 - i));
    cursor = destClose + 1;
    i = destClose;
  }
  return cursor === 0 ? text : parts.join('') + text.slice(cursor);
}

export function inlineReferencedIndexes(text: string): { files: Set<number>; media: Set<number> } {
  const files = new Set<number>();
  const media = new Set<number>();
  if (!text.includes(INLINE_ATTACHMENT_DESTINATION)) return { files, media };
  text = maskImageSpans(text);
  let labelStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') {
      labelStart = -1;
    } else if (ch === '[' && labelStart === -1 && text[i - 1] !== '!' && text[i - 1] !== '\\') {
      labelStart = i;
    } else if (ch === ']') {
      if (
        labelStart !== -1 &&
        i > labelStart + 1 &&
        text.startsWith(INLINE_ATTACHMENT_DESTINATION, i)
      ) {
        let start = i + INLINE_ATTACHMENT_DESTINATION.length;
        const isMedia = text[start] === 'm';
        if (isMedia) start += 1;
        let end = start;
        if (text.charCodeAt(end) >= 49 && text.charCodeAt(end) <= 57) {
          do {
            end += 1;
          } while (text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57);
          if (text[end] === ')') {
            (isMedia ? media : files).add(Number(text.slice(start, end)));
            i = end;
          }
        }
      }
      labelStart = -1;
    } else if (ch === '\\' && text[i + 1] !== '\n') {
      i += 1;
    }
  }
  return { files, media };
}
