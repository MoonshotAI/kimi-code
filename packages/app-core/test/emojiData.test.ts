import { describe, expect, it } from 'vitest';
import { EMOJI_ENTRIES, pushRecentEmoji, RECENT_EMOJIS_MAX, searchEmojis } from '../src/lib/emojiData';
import { splitSessionEmoji } from '../src/lib/sessionEmoji';

describe('searchEmojis', () => {
  it('matches English keywords case-insensitively', () => {
    expect(searchEmojis('FIRE')).toContain('🔥');
    expect(searchEmojis('rocket')).toEqual(['🚀']);
  });

  it('matches Chinese keywords by substring', () => {
    expect(searchEmojis('咖啡')).toEqual(['☕']);
    expect(searchEmojis('电脑')).toEqual(expect.arrayContaining(['💻', '🖥️']));
  });

  it('matches partial keywords', () => {
    // "chart" is a prefix of both bar-chart and trend entries.
    const hits = searchEmojis('chart');
    expect(hits).toEqual(expect.arrayContaining(['📊', '📈', '📉']));
  });

  it('returns an empty array for an empty query', () => {
    expect(searchEmojis('')).toEqual([]);
    expect(searchEmojis('   ')).toEqual([]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(searchEmojis('qqqzzz')).toEqual([]);
  });

  it('caps the results at the limit', () => {
    expect(searchEmojis('圆', 2)).toHaveLength(2);
  });
});

describe('pushRecentEmoji', () => {
  it('prepends the emoji', () => {
    expect(pushRecentEmoji(['🐛', '⏳'], '🔥')).toEqual(['🔥', '🐛', '⏳']);
  });

  it('deduplicates an existing entry to the front', () => {
    expect(pushRecentEmoji(['🐛', '⏳', '🔥'], '🔥')).toEqual(['🔥', '🐛', '⏳']);
  });

  it('caps the list at the max', () => {
    const full = Array.from({ length: RECENT_EMOJIS_MAX }, (_, i) => `e${i}`);
    const next = pushRecentEmoji(full, '🔥');
    expect(next).toHaveLength(RECENT_EMOJIS_MAX);
    expect(next[0]).toBe('🔥');
    expect(next.at(-1)).toBe(`e${RECENT_EMOJIS_MAX - 2}`);
  });
});

describe('EMOJI_ENTRIES', () => {
  it('every entry round-trips through splitSessionEmoji as the session icon', () => {
    for (const { emoji } of EMOJI_ENTRIES) {
      expect(splitSessionEmoji(`${emoji} 标题`).emoji).toBe(emoji);
    }
  });

  it('has no duplicate entries', () => {
    const all = EMOJI_ENTRIES.map((e) => e.emoji);
    expect(new Set(all).size).toBe(all.length);
  });
});
