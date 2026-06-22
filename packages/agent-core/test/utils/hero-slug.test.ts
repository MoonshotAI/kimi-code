import { describe, expect, it } from 'vitest';

import { HERO_NAMES, generateHeroSlug } from '#/_utils/slug';

describe('generateHeroSlug', () => {
  it('returns a slug made of exactly 3 hero names joined by "-"', () => {
    const slug = generateHeroSlug('ses_0001', new Set());
    const heroPattern = HERO_NAMES.map((n) => n.replaceAll('-', '\\-')).join('|');
    const re = new RegExp(`^(${heroPattern})-(${heroPattern})-(${heroPattern})$`);
    expect(slug).toMatch(re);
  });

  it('appends the first 8 chars of id when every 3-name combo collides', () => {
    // "Universal-match" Set: always reports `has() === true` so the
    // generator exhausts its retry limit and falls back to the suffixed
    // slug, regardless of RNG output.
    const universal = new (class extends Set<string> {
      override has(_v: string): boolean {
        return true;
      }
    })();
    const slug = generateHeroSlug('sess_abcdefgh_XXXX', universal as unknown as Set<string>);
    expect(slug).toMatch(/-sess_abc$/);
  });
});
