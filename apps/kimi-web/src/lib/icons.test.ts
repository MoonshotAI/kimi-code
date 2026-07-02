// apps/kimi-web/src/lib/icons.test.ts
import { describe, expect, it } from 'vitest';
import { ICONS, iconSvg } from './icons';

describe('ICONS registry', () => {
  it('has a non-empty body for every entry', () => {
    for (const [name, def] of Object.entries(ICONS)) {
      expect(def.body.trim(), `${name} body`).not.toBe('');
    }
  });

  it('bodies contain only inner SVG markup (no outer <svg>)', () => {
    for (const [name, def] of Object.entries(ICONS)) {
      expect(def.body.toLowerCase(), `${name}`).not.toContain('<svg');
    }
  });

  it('every entry is fill-based on a 24x24 grid (Remix)', () => {
    for (const [name, def] of Object.entries(ICONS)) {
      expect(def.fill, `${name} fill`).toBe(true);
      expect(def.viewBox, `${name} viewBox`).toBe('0 0 24 24');
    }
  });
});

describe('iconSvg', () => {
  it('renders a Remix icon with the registry defaults', () => {
    const svg = iconSvg('plus');
    expect(svg.startsWith('<svg class="kw-icon"')).toBe(true);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toContain('stroke=');
    expect(svg).toContain(ICONS.plus.body);
  });

  it('maps size tokens to pixel width/height', () => {
    expect(iconSvg('plus', 'sm')).toContain('width="14" height="14"');
    expect(iconSvg('plus', 'md')).toContain('width="16" height="16"');
    expect(iconSvg('plus', 'lg')).toContain('width="20" height="20"');
  });

  it('renders a filled icon with currentColor and no stroke', () => {
    const svg = iconSvg('star');
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toContain('stroke=');
  });
});
