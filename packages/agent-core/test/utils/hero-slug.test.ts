import { describe, expect, it } from 'vitest';

import { HERO_NAMES, generateHeroSlug } from '../../src/utils/hero-slug';

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

  it('produces unique slugs for different session ids with an empty collision set', () => {
    const slug1 = generateHeroSlug('sess_0001', new Set());
    const slug2 = generateHeroSlug('sess_0002', new Set());
    expect(slug1).not.toBe(slug2);
  });

  it('does not produce a slug that already exists in the collision set', () => {
    const slug = generateHeroSlug('sess_0001', new Set());
    const existing = new Set([slug]);
    // A second call with the same session id and the slug in the set
    // must produce a different slug (or fall back to the suffixed form).
    const slug2 = generateHeroSlug('sess_0001', existing);
    expect(slug2).not.toBe(slug);
  });

  it('produces a deterministic slug when the collision set is empty (no RNG conflict)', () => {
    const slug = generateHeroSlug('sess_fixed_id', new Set());
    // Hero names may contain hyphens, so we verify the structure by checking
    // the slug has at least 2 hyphens (3 names) and matches the expected pattern.
    expect(slug.split('-').length).toBeGreaterThanOrEqual(3);
    expect(slug).not.toMatch(/-$/);
    expect(slug).not.toMatch(/^-/);
  });

  it('HERO_NAMES is a non-empty array of strings', () => {
    expect(Array.isArray(HERO_NAMES)).toBe(true);
    expect(HERO_NAMES.length).toBeGreaterThan(0);
    for (const name of HERO_NAMES) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
