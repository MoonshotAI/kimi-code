
let graphemeSegmenter: Intl.Segmenter | undefined;

function graphemes(title: string): Intl.Segments | undefined {
  if (typeof Intl.Segmenter !== 'function') return undefined;
  graphemeSegmenter ??= new Intl.Segmenter('und', { granularity: 'grapheme' });
  return graphemeSegmenter.segment(title);
}

const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;
const REGIONAL_INDICATOR_RE = /\p{Regional_Indicator}/u;
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
const VARIATION_SELECTOR_16 = '\uFE0F';

function isEmojiCluster(cluster: string): boolean {
  if (EMOJI_PRESENTATION_RE.test(cluster)) return true;
  if (REGIONAL_INDICATOR_RE.test(cluster)) return true;
  return EXTENDED_PICTOGRAPHIC_RE.test(cluster) && cluster.includes(VARIATION_SELECTOR_16);
}

export interface SessionEmojiSplit {
  emoji: string | null;
  rest: string;
}

export function splitSessionEmoji(title: string): SessionEmojiSplit {
  const first = graphemes(title)?.[Symbol.iterator]().next().value;
  if (first === undefined || !isEmojiCluster(first.segment)) return { emoji: null, rest: title };
  const rest = title.slice(first.index + first.segment.length).replace(/^\s+/, '');
  return { emoji: first.segment, rest };
}

export function applySessionEmoji(title: string, emoji: string | null): string {
  const { rest } = splitSessionEmoji(title);
  const next = emoji?.trim() ?? '';
  if (!next) return rest;
  return rest ? `${next} ${rest}` : next;
}
