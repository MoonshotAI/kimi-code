import { describe, expect, it } from 'vitest';
import { applySessionEmoji, splitSessionEmoji } from '../src/lib/sessionEmoji';

describe('splitSessionEmoji', () => {
  it('returns null emoji for plain titles', () => {
    expect(splitSessionEmoji('做一个 desktop 的需求')).toEqual({
      emoji: null,
      rest: '做一个 desktop 的需求',
    });
  });

  it('splits a leading emoji and its separating space', () => {
    expect(splitSessionEmoji('⏳ 做一个 desktop 的需求')).toEqual({
      emoji: '⏳',
      rest: '做一个 desktop 的需求',
    });
  });

  it('handles VS16 sequences (⚠️ = U+26A0 U+FE0F) as one emoji', () => {
    const { emoji, rest } = splitSessionEmoji('⚠️ 排查一个 bug');
    expect(emoji).toBe('⚠️');
    expect(rest).toBe('排查一个 bug');
  });

  it('handles ZWJ sequences as a single cluster', () => {
    const { emoji, rest } = splitSessionEmoji('👨‍👩‍👧 家庭事项');
    expect(emoji).toBe('👨‍👩‍👧');
    expect(rest).toBe('家庭事项');
  });

  it('handles flags (Regional_Indicator pairs)', () => {
    const { emoji, rest } = splitSessionEmoji('🇨🇳 本地化');
    expect(emoji).toBe('🇨🇳');
    expect(rest).toBe('本地化');
  });

  it('returns an empty rest for emoji-only titles', () => {
    expect(splitSessionEmoji('⏳')).toEqual({ emoji: '⏳', rest: '' });
  });

  it('strips a run of spaces after the emoji', () => {
    expect(splitSessionEmoji('🔥   紧急')).toEqual({ emoji: '🔥', rest: '紧急' });
  });

  it('does not treat ASCII digits as emoji (Extended_Pictographic false positive)', () => {
    expect(splitSessionEmoji('2 个 bug')).toEqual({ emoji: null, rest: '2 个 bug' });
    expect(splitSessionEmoji('# 标签')).toEqual({ emoji: null, rest: '# 标签' });
  });

  it('does not treat text-presentation marks without VS16 as icons', () => {
    const title = '⚠ 裸警告符';
    expect(splitSessionEmoji(title)).toEqual({ emoji: null, rest: title });
  });

  it('leaves titles with leading whitespace untouched', () => {
    const title = ' ⏳ 前导空格';
    expect(splitSessionEmoji(title)).toEqual({ emoji: null, rest: title });
  });

  it('handles empty titles', () => {
    expect(splitSessionEmoji('')).toEqual({ emoji: null, rest: '' });
  });

  it('degrades to "no icon" when Intl.Segmenter is unavailable', () => {
    const original = Intl.Segmenter;
    // @ts-expect-error deliberately simulating a webview without the API
    Intl.Segmenter = undefined;
    try {
      expect(splitSessionEmoji('⏳ 标题')).toEqual({ emoji: null, rest: '⏳ 标题' });
      expect(applySessionEmoji('⏳ 标题', '🔥')).toBe('🔥 ⏳ 标题');
    } finally {
      Intl.Segmenter = original;
    }
  });
});

describe('applySessionEmoji', () => {
  it('prepends an emoji to a plain title', () => {
    expect(applySessionEmoji('新标题', '🎯')).toBe('🎯 新标题');
  });

  it('replaces an existing emoji', () => {
    expect(applySessionEmoji('⏳ 旧', '🔥')).toBe('🔥 旧');
  });

  it('removes the emoji when null', () => {
    expect(applySessionEmoji('⏳ 旧', null)).toBe('旧');
  });

  it('is a no-op when removing from a plain title', () => {
    expect(applySessionEmoji('旧', null)).toBe('旧');
  });

  it('does not emit a trailing space when the text is empty', () => {
    expect(applySessionEmoji('⏳', '🔥')).toBe('🔥');
    expect(applySessionEmoji('', '⏳')).toBe('⏳');
  });

  it('round-trips through splitSessionEmoji', () => {
    for (const [title, emoji] of [
      ['做一个 desktop 的需求', '🎨'],
      ['⏳ 旧', '🇨🇳'],
      ['⚠️ 排查 bug', '✨'],
    ] as const) {
      const next = applySessionEmoji(title, emoji);
      expect(splitSessionEmoji(next)).toEqual({ emoji, rest: splitSessionEmoji(title).rest });
    }
  });
});
