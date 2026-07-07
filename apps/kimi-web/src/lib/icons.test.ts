// apps/kimi-web/src/lib/icons.test.ts
import { describe, expect, it } from 'vitest';
import { ICONS, SIZE_PX, getIcon, iconSvg } from './icons';

describe('ICONS registry', () => {
  it('is non-empty', () => {
    expect(Object.keys(ICONS).length).toBeGreaterThan(0);
  });

  it('every entry has a component and a non-empty raw svg', () => {
    for (const [name, entry] of Object.entries(ICONS)) {
      // unplugin-icons component can be a function or a defineComponent object
      const ct = typeof entry.component;
      expect(['function', 'object'], `${name} component type`).toContain(ct);
      expect(typeof entry.svg, `${name} svg type`).toBe('string');
      expect(entry.svg.trim(), `${name} svg`).not.toBe('');
      expect(entry.svg.toLowerCase(), `${name} svg contains <svg`).toContain('<svg');
    }
  });

  it('every entry svg is on a 24x24 grid with a viewBox', () => {
    for (const [name, entry] of Object.entries(ICONS)) {
      expect(entry.svg, `${name} viewBox`).toContain('viewBox="0 0 24 24"');
    }
  });
});

describe('getIcon', () => {
  it('returns the entry for a known name', () => {
    expect(getIcon('plus')).toBe(ICONS.plus);
  });

  it('returns undefined for an unknown name (runtime fallback)', () => {
    // @ts-expect-error - intentional runtime misuse path
    expect(getIcon('definitely-not-an-icon')).toBeUndefined();
  });
});

describe('iconSvg', () => {
  it('renders a Remix icon with kw-icon class and default md size', () => {
    const svg = iconSvg('plus');
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('class="kw-icon"');
    expect(svg).toContain('width="16" height="16"');
  });

  it('maps size tokens to pixel width/height', () => {
    expect(iconSvg('plus', 'sm')).toContain(`width="${SIZE_PX.sm}" height="${SIZE_PX.sm}"`);
    expect(iconSvg('plus', 'md')).toContain(`width="${SIZE_PX.md}" height="${SIZE_PX.md}"`);
    expect(iconSvg('plus', 'lg')).toContain(`width="${SIZE_PX.lg}" height="${SIZE_PX.lg}"`);
  });

  it('does not duplicate width/height attributes from the raw icon', () => {
    const svg = iconSvg('plus');
    const widthCount = (svg.match(/\bwidth="/g) ?? []).length;
    const heightCount = (svg.match(/\bheight="/g) ?? []).length;
    expect(widthCount).toBe(1);
    expect(heightCount).toBe(1);
  });

  it('returns empty string for an unknown name', () => {
    // @ts-expect-error - intentional runtime misuse path
    expect(iconSvg('definitely-not-an-icon')).toBe('');
  });
});
