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

  it('same id generates different slugs when no collision', () => {
    const existing = new Set<string>();
    const slug1 = generateHeroSlug('ses_001', existing);
    existing.add(slug1);
    const slug2 = generateHeroSlug('ses_001', existing);
    expect(slug1).not.toBe(slug2);
    expect(slug1.length).toBeGreaterThan(0);
    expect(slug2.length).toBeGreaterThan(0);
  });

  it('very long id still produces a valid slug on collision', () => {
    const universal = new (class extends Set<string> {
      override has(): boolean {
        return true;
      }
    })();
    const longId = 'session_' + 'x'.repeat(100) + '_extra';
    const slug = generateHeroSlug(longId, universal as unknown as Set<string>);
    expect(slug.length).toBeGreaterThan(0);
    expect(slug).toMatch(/[a-z0-9_-]+$/);
  });

  it('empty id still produces a slug', () => {
    const slug = generateHeroSlug('', new Set());
    expect(slug.length).toBeGreaterThan(0);
  });
});
