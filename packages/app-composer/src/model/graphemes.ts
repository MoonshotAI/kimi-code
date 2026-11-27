

let graphemeSegmenter: Intl.Segmenter | undefined;

export function splitGraphemes(text: string): string[] {
  graphemeSegmenter ??= new Intl.Segmenter('und', { granularity: 'grapheme' });
  return [...graphemeSegmenter.segment(text)].map((part) => part.segment);
}

export function truncateGraphemes(text: string, max: number): string {
  const chars = splitGraphemes(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}
