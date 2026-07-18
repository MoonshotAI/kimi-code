import { describe, expect, it } from 'vitest';

import { generateHeroSlug, HERO_NAMES } from '#/_base/utils/hero-slug';

describe('generateHeroSlug', () => {
  it('returns a slug made of exactly 3 hero names joined by "-"', () => {
    const slug = generateHeroSlug('ses_0001', new Set());
    const heroPattern = HERO_NAMES.map((name) => name.replaceAll('-', '\\-')).join('|');
    const pattern = new RegExp(`^(${heroPattern})-(${heroPattern})-(${heroPattern})$`);

    expect(slug).toMatch(pattern);
  });

  it('appends the first 8 chars of id when every 3-name combo collides', () => {
    const universal = new (class extends Set<string> {
      override has(): boolean {
        return true;
      }
    })();

    const slug = generateHeroSlug('sess_abcdefgh_XXXX', universal as unknown as Set<string>);

    expect(slug).toMatch(/-sess_abc$/);
  });
});
