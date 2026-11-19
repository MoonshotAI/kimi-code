import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = luminance(a) >= luminance(b) ? [a, b] : [b, a];
  return (luminance(hi) + 0.05) / (luminance(lo) + 0.05);
}
function hex(s: string): Rgb {
  return [
    parseInt(s.slice(1, 3), 16),
    parseInt(s.slice(3, 5), 16),
    parseInt(s.slice(5, 7), 16),
  ];
}
function rgbaOver(rgb: Rgb, alpha: number, bg: Rgb): Rgb {
  return rgb.map((c, i) => alpha * c + (1 - alpha) * bg[i]) as Rgb;
}
function parseRgba(value: string): { rgb: Rgb; alpha: number } {
  const m = value.match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/);
  if (!m) throw new Error(`not an rgba() token: ${value}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

const css = readFileSync(new URL('../../../app-ui/src/style.css', import.meta.url), 'utf8');

function tokenValues(name: string): string[] {
  return [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map((m) => m[1]!.trim());
}

const WELL_LIGHT = hex('#f5f5f5');
const WELL_DARK = hex('#1f1f1f');

function selection(index: number, well: Rgb): Rgb {
  const { rgb, alpha } = parseRgba(tokenValues('--color-code-selection')[index]!);
  return rgbaOver(rgb, alpha, well);
}
const lightSel = () => selection(0, WELL_LIGHT);
const darkSel = () => selection(1, WELL_DARK);

const GH_LIGHT: Record<string, Rgb> = {
  base: hex('#1f2328'),
  string: hex('#0a3069'),
  number: hex('#0550ae'),
  variable: hex('#953800'),
  comment: hex('#59636e'),
  keyword: hex('#cf222e'),
  function: hex('#8250df'),
};
const GH_DARK: Record<string, Rgb> = {
  base: hex('#e6edf3'),
  string: hex('#a5d6ff'),
  number: hex('#79c0ff'),
  variable: hex('#ffa198'),
  comment: hex('#8b949e'),
  keyword: hex('#ff7b72'),
  function: hex('#d2a8ff'),
};

describe('code selection tokens (WCAG 1.4.3 + product visibility floor)', () => {
  it('light: fill vs the code well ≥ 1.5 (product floor)', () => {
    expect(contrast(lightSel(), WELL_LIGHT)).toBeGreaterThanOrEqual(1.5);
  });

  it('light: base/string/number/variable fg ≥ 4.5 vs the fill (1.4.3)', () => {
    for (const name of ['base', 'string', 'number', 'variable']) {
      expect(contrast(GH_LIGHT[name]!, lightSel()), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('light: comment/keyword/function are documented residuals (< 4.5 by construction)', () => {
    for (const name of ['comment', 'keyword', 'function']) {
      expect(contrast(GH_LIGHT[name]!, lightSel()), name).toBeLessThan(4.5);
      expect(contrast(GH_LIGHT[name]!, lightSel()), name).toBeGreaterThanOrEqual(3);
    }
  });

  it('dark: fill vs the code well ≥ 1.44 (accepted ≈1.5 trade — keeps keyword ≥ 4.5)', () => {
    expect(contrast(darkSel(), WELL_DARK)).toBeGreaterThanOrEqual(1.44);
  });

  it('dark: base/string/number/variable/keyword/function fg ≥ 4.5 vs the fill (1.4.3)', () => {
    for (const name of ['base', 'string', 'number', 'variable', 'keyword', 'function']) {
      expect(contrast(GH_DARK[name]!, darkSel()), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('dark: comment is a documented residual (< 4.5 by construction)', () => {
    expect(contrast(GH_DARK.comment!, darkSel())).toBeLessThan(4.5);
    expect(contrast(GH_DARK.comment!, darkSel())).toBeGreaterThanOrEqual(3);
  });
});
