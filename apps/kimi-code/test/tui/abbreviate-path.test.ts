import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { abbreviatePath, clipToWidth } from '#/tui/utils/abbreviate-path';

const LONG = 'this/is/a/long/path/and/should/be/omitted/right.md';

describe('abbreviatePath', () => {
  it('returns the path unchanged when it fits', () => {
    expect(abbreviatePath('src/auth.ts', 40)).toBe('src/auth.ts');
  });

  it('returns empty for a non-positive width', () => {
    expect(abbreviatePath(LONG, 0)).toBe('');
    expect(abbreviatePath(LONG, -5)).toBe('');
  });

  it('elides middle segments with one … each, keeping head and tail', () => {
    // Pinned visual contract from the design discussion.
    expect(abbreviatePath(LONG, 36)).toBe('this/is/…/…/…/…/…/…/omitted/right.md');
  });

  it('keeps more real segments when more width is available', () => {
    const result = abbreviatePath(LONG, 44);
    expect(visibleWidth(result)).toBeLessThanOrEqual(44);
    // Wider budget → fewer omitted segments than the width-36 rendering.
    expect((result.match(/…/g) ?? []).length).toBeLessThan(6);
    expect(result.startsWith('this/')).toBe(true);
    expect(result.endsWith('/right.md')).toBe(true);
  });

  it('collapses a long run of omitted segments to ……', () => {
    const result = abbreviatePath(LONG, 18);
    expect(visibleWidth(result)).toBeLessThanOrEqual(18);
    expect(result).toContain('……');
    expect(result.endsWith('right.md')).toBe(true);
  });

  it('abbreviates the end segments themselves when space is very small', () => {
    const result = abbreviatePath(LONG, 12);
    expect(visibleWidth(result)).toBeLessThanOrEqual(12);
    // The leading segment is truncated to a prefix + …, the trailing segment
    // keeps its extension, and the long middle run collapses to …….
    expect(result.split('/')[0]).toMatch(/^t.*…$/);
    expect(result.endsWith('.md')).toBe(true);
    expect(result).toContain('……');
  });

  it('middle-truncates a single long segment, preserving the extension', () => {
    const result = abbreviatePath('reallylongfilename.md', 8);
    expect(visibleWidth(result)).toBeLessThanOrEqual(8);
    expect(result.endsWith('.md')).toBe(true);
    expect(result).toContain('…');
  });

  it('never exceeds the budget across a range of widths', () => {
    for (let width = 1; width <= 60; width++) {
      expect(visibleWidth(abbreviatePath(LONG, width))).toBeLessThanOrEqual(width);
    }
  });
});

describe('clipToWidth', () => {
  it('returns the text unchanged when it fits', () => {
    expect(clipToWidth('short title', 40)).toBe('short title');
  });

  it('truncates with a trailing ellipsis and never exceeds the width', () => {
    const out = clipToWidth('a fairly long commit subject line', 12);
    expect(visibleWidth(out)).toBeLessThanOrEqual(12);
    expect(out.endsWith('…')).toBe(true);
  });

  it('produces no ANSI escape codes, so callers can color the whole string', () => {
    const out = clipToWidth('a fairly long commit subject line', 12);
    // pi-tui truncateToWidth with an ellipsis marker wraps it in reset codes;
    // clipToWidth must not, or coloring the result would break at the ellipsis.
    expect(/\u001B/.test(out)).toBe(false);
  });
});
