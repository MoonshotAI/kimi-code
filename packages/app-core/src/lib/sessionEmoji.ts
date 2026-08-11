// app-core lib/sessionEmoji — a session's "icon" is the leading emoji cluster
// of its title; these helpers are the one parse/write rule for it.

// Constructed lazily: the lib must stay side-effect-free for every importer,
// and environments without Intl.Segmenter degrade to "no icon" instead of
// throwing during sidebar rendering.
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

// Detection is deliberately conservative to avoid false positives on plain
// text: Emoji_Presentation code points, Regional_Indicator pairs (flags), or
// Extended_Pictographic + VS16 (⚠️ as typed by OS emoji pickers). Bare ASCII
// digits / '#' / '*' are Extended_Pictographic but are NOT icons, and neither
// are text-presentation marks (bare "⚠", "❤") or keycap sequences.
function isEmojiCluster(cluster: string): boolean {
  if (EMOJI_PRESENTATION_RE.test(cluster)) return true;
  if (REGIONAL_INDICATOR_RE.test(cluster)) return true;
  return EXTENDED_PICTOGRAPHIC_RE.test(cluster) && cluster.includes(VARIATION_SELECTOR_16);
}

export interface SessionEmojiSplit {
  /** Leading emoji cluster, or null when the title starts with plain text. */
  emoji: string | null;
  /** Title text with the emoji prefix (and one separating run of spaces) removed. */
  rest: string;
}

/** Split a session title into its leading emoji icon and the remaining text. */
export function splitSessionEmoji(title: string): SessionEmojiSplit {
  const first = graphemes(title)?.[Symbol.iterator]().next().value;
  if (first === undefined || !isEmojiCluster(first.segment)) return { emoji: null, rest: title };
  const rest = title.slice(first.index + first.segment.length).replace(/^\s+/, '');
  return { emoji: first.segment, rest };
}

/**
 * Return the title with its emoji prefix replaced / inserted / removed
 * (`emoji: null`). The title text itself is left untouched.
 */
export function applySessionEmoji(title: string, emoji: string | null): string {
  const { rest } = splitSessionEmoji(title);
  const next = emoji?.trim() ?? '';
  if (!next) return rest;
  return rest ? `${next} ${rest}` : next;
}
