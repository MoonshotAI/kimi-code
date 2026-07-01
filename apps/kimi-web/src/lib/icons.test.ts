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
});

describe('iconSvg', () => {
  it('renders a line icon with the registry defaults', () => {
    const svg = iconSvg('plus');
    expect(svg.startsWith('<svg class="kw-icon"')).toBe(true);
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg).toContain(ICONS.plus.body);
  });

  it('maps size tokens to pixel width/height', () => {
    expect(iconSvg('plus', 'sm')).toContain('width="14" height="14"');
    expect(iconSvg('plus', 'md')).toContain('width="16" height="16"');
    expect(iconSvg('plus', 'lg')).toContain('width="20" height="20"');
  });

  it('keeps a custom viewBox for off-grid icons', () => {
    expect(iconSvg('settings')).toContain('viewBox="0 0 24 24"');
  });

  it('renders filled icons with currentColor and no stroke', () => {
    const svg = iconSvg('star');
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toContain('stroke=');
  });
});
