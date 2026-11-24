export function textAttributes(raw: string, nameChar: RegExp = /[\w-]/): Record<string, string> {
  const attributes: Record<string, string> = {};
  let i = 0;
  while (i < raw.length) {
    if (!nameChar.test(raw[i]!)) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < raw.length && nameChar.test(raw[i]!)) i += 1;
    if (raw[i] !== '=' || raw[i + 1] !== '"') continue;
    const end = raw.indexOf('"', i + 2);
    if (end === -1) break;
    attributes[raw.slice(start, i)] = raw.slice(i + 2, end);
    i = end + 1;
  }
  return attributes;
}

export function firstDelimitedText(text: string, opening: string, closing: string): string | undefined {
  const start = text.indexOf(opening);
  if (start === -1) return undefined;
  const contentStart = start + opening.length;
  const end = text.indexOf(closing, contentStart);
  return end === -1 ? undefined : text.slice(contentStart, end);
}
