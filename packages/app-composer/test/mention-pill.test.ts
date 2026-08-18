import { describe, expect, it } from 'vitest';
import { MENTION_NAME_MAX, truncateMentionName } from '../src/mentionPill';

// Pill labels cap at MENTION_NAME_MAX grapheme clusters; longer names take
// a middle ellipsis that keeps the head of the base name AND the whole
// extension — the two informative ends of a file name.
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
    // dotfile: lastIndexOf('.') === 0 → no ext → middle split of the whole
    const name = `.${'hidden'.repeat(8)}`;
    const out = truncateMentionName(name);
    expect(out.length).toBe(MENTION_NAME_MAX);
    expect(out).toContain('…');
  });

  it('counts the budget in grapheme clusters, not UTF-16 units', () => {
    // 20 emoji + ".png" = 24 clusters but 44 UTF-16 units: still fits.
    const name = `${'😀'.repeat(20)}.png`;
    expect(name.length).toBeGreaterThan(MENTION_NAME_MAX);
    expect(truncateMentionName(name)).toBe(name);
  });

  it('never cuts an emoji in half at the truncation boundary', () => {
    // An unpaired surrogate would render as `�`.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // The head budget ends exactly on this emoji — a UTF-16 slice would
    // keep only its high surrogate.
    const pair = truncateMentionName(`${'ab'.repeat(11)}😀${'c'.repeat(20)}.txt`);
    expect(pair).toBe(`${'ab'.repeat(11)}😀…cccc.txt`);
    expect(loneSurrogate.test(pair)).toBe(false);
    // A ZWJ emoji sequence is ONE cluster: kept whole, never partially.
    const family = '👨‍👩‍👧‍👦';
    const zwj = truncateMentionName(`${'a'.repeat(20)}${family}${'c'.repeat(20)}.txt`);
    expect(zwj).toBe(`${'a'.repeat(20)}${family}cc…cccc.txt`);
    expect(loneSurrogate.test(zwj)).toBe(false);
  });
});
