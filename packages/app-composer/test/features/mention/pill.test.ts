import { describe, expect, it } from 'vitest';
import { MENTION_NAME_MAX, truncateMentionName, truncateMentionNameTo } from '../../../src/features/mention/pill';

describe('truncateMentionName', () => {
  it('leaves short and exactly-at-cap names untouched', () => {
    expect(truncateMentionName('ChatPane.vue')).toBe('ChatPane.vue');
    const atCap = 'a'.repeat(MENTION_NAME_MAX - 4) + '.vue';
    expect(atCap.length).toBe(MENTION_NAME_MAX);
    expect(truncateMentionName(atCap)).toBe(atCap);
  });

  it('middle-truncates long names, keeping the extension', () => {
    const name = 'averyverylongfilenamecomponent.tsx';
    const out = truncateMentionName(name);
    expect(out.length).toBe(MENTION_NAME_MAX);
    expect(out).toContain('…');
    expect(out.endsWith('.tsx')).toBe(true);
    expect(out.startsWith(name.slice(0, 12))).toBe(true);
  });

  it('handles extension-less names with a plain middle split', () => {
    const name = 'a'.repeat(40);
    const out = truncateMentionName(name);
    expect(out.length).toBe(MENTION_NAME_MAX);
    expect(out).toBe(`${'a'.repeat(27)}…aaaa`);
  });

  it('falls back to end-ellipsis for pathological extensions', () => {
    const name = `file.${'x'.repeat(40)}`;
    const out = truncateMentionName(name);
    expect(out.length).toBe(MENTION_NAME_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('keeps trailing dots / dotfiles sensible', () => {
    const name = `.${'hidden'.repeat(8)}`;
    const out = truncateMentionName(name);
    expect(out.length).toBe(MENTION_NAME_MAX);
    expect(out).toContain('…');
  });

  it('counts the budget in grapheme clusters, not UTF-16 units', () => {
    const name = `${'😀'.repeat(20)}.png`;
    expect(name.length).toBeGreaterThan(MENTION_NAME_MAX);
    expect(truncateMentionName(name)).toBe(name);
  });

  it('never cuts an emoji in half at the truncation boundary', () => {
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const pair = truncateMentionName(`${'ab'.repeat(11)}😀${'c'.repeat(20)}.txt`);
    expect(pair).toBe(`${'ab'.repeat(11)}😀…cccc.txt`);
    expect(loneSurrogate.test(pair)).toBe(false);
    const family = '👨‍👩‍👧‍👦';
    const zwj = truncateMentionName(`${'a'.repeat(20)}${family}${'c'.repeat(20)}.txt`);
    expect(zwj).toBe(`${'a'.repeat(20)}${family}cc…cccc.txt`);
    expect(loneSurrogate.test(zwj)).toBe(false);
  });
});

describe('truncateMentionNameTo', () => {
  it('is identical to the fixed-cap wrapper at MENTION_NAME_MAX', () => {
    const name = 'a-very-long-screenshot-name-from-cleanshot-2026-08-25-at-19.53.27@2x.png';
    expect(truncateMentionNameTo(name, MENTION_NAME_MAX)).toBe(truncateMentionName(name));
  });

  it('honours a smaller cap (a narrow popover still keeps the extension)', () => {
    const name = 'Claude 2026-08-22 17.45.04.png';
    const out = truncateMentionNameTo(name, 12);
    expect([...out].length).toBe(12);
    expect(out.endsWith('.png')).toBe(true);
    expect(out).toContain('…');
  });

  it('passes names at or under the cap through untouched', () => {
    expect(truncateMentionNameTo('a.pdf', 12)).toBe('a.pdf');
  });
});
