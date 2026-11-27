import { describe, expect, it } from 'vitest';
import { ICONS, SIZE_PX, getIcon, iconSvg } from '../src/icons/icons';

describe('ICONS registry', () => {
  it('is non-empty', () => {
    expect(Object.keys(ICONS).length).toBeGreaterThan(0);
  });

  it('every entry has a component and a non-empty raw svg', () => {
    for (const [name, entry] of Object.entries(ICONS)) {
      const ct = typeof entry.component;
      expect(['function', 'object'], `${name} component type`).toContain(ct);
      expect(typeof entry.svg, `${name} svg type`).toBe('string');
      expect(entry.svg.trim(), `${name} svg`).not.toBe('');
      expect(entry.svg.toLowerCase(), `${name} svg contains <svg`).toContain('<svg');
    }
  });

  it('uses the declared viewBox for icons and the dedicated browser cursor', () => {
    for (const [name, entry] of Object.entries(ICONS)) {
      if (name.startsWith('ft-')) {
        expect(entry.svg, `${name} viewBox`).toMatch(/viewBox="[-\d. ]+"/);
        continue;
      }
      const viewBox = name === 'browser-pointer' ? '0 0 40 56' : '0 0 24 24';
      expect(entry.svg, `${name} viewBox`).toContain(`viewBox="${viewBox}"`);
    }
  });

  it('uses Kimi Design artwork for MCP, plugin, and skill', () => {
    expect(ICONS.mcp.svg).toContain('M12.4745 3.09473');
    expect(ICONS.plugin.svg).toContain('M15.3128 3.17132');
    expect(ICONS.skill.svg).toContain('M16.5001 8.2002');
    for (const name of ['mcp', 'plugin', 'skill'] as const) {
      expect(ICONS[name].svg).toContain('currentColor');
    }
  });
});

describe('getIcon', () => {
  it('returns the entry for a known name', () => {
    expect(getIcon('plus')).toBe(ICONS.plus);
  });

  it('registers the file-diff icon for change entry points', () => {
    expect(getIcon('file-diff')?.svg).toContain('<svg');
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

  it('does not duplicate width/height attributes on the root <svg>', () => {
    const svg = iconSvg('plus');
    const root = svg.match(/^<svg\b[^>]*>/)?.[0] ?? '';
    expect((root.match(/\bwidth="/g) ?? []).length).toBe(1);
    expect((root.match(/\bheight="/g) ?? []).length).toBe(1);
  });

  it('returns empty string for an unknown name', () => {
    // @ts-expect-error - intentional runtime misuse path
    expect(iconSvg('definitely-not-an-icon')).toBe('');
  });
});

describe('key-option glyph', () => {
  function subpaths(name: 'key-option'): Array<Array<[number, number]>> {
    const d = ICONS[name].svg.match(/\bd="([^"]+)"/)?.[1] ?? '';
    const result: Array<Array<[number, number]>> = [];
    let x = 0;
    let y = 0;
    for (const [, cmd, args] of d.matchAll(/([MLHVZ])([^MLHVZ]*)/g)) {
      const n = (args ?? '').match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
      if (cmd === 'Z') continue;
      if (cmd === 'M' || cmd === 'L') [x, y] = [n[0] ?? 0, n[1] ?? 0];
      if (cmd === 'H') x = n[0] ?? 0;
      if (cmd === 'V') y = n[0] ?? 0;
      if (cmd === 'M') result.push([]);
      result.at(-1)?.push([x, y]);
    }
    return result;
  }

  function bounds(points: Array<[number, number]>) {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  it('matches the macOS option symbol: upper-left bar sloping down to a lower-right bar, plus a detached upper-right bar', () => {
    const parts = subpaths('key-option');
    expect(parts).toHaveLength(2);
    const [stroke = [], bar = []] = parts;
    const s = bounds(stroke);
    const b = bounds(bar);
    const leftmost = stroke.filter(([x]) => x === s.minX);
    const rightmost = stroke.filter(([x]) => x === s.maxX);
    expect(Math.min(...leftmost.map(([, y]) => y))).toBe(s.minY);
    expect(Math.max(...rightmost.map(([, y]) => y))).toBe(s.maxY);
    expect(b.minY).toBe(s.minY);
    expect(b.maxY).toBeLessThan((s.minY + s.maxY) / 2);
    expect(b.minX).toBeGreaterThan((s.minX + s.maxX) / 2);
    expect(b.maxX).toBe(s.maxX);
  });
});
