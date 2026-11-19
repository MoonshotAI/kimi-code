import { describe, expect, it } from 'vitest';
import {
  fontFamilyKind,
  parseFontFamilyList,
  resolvePrimaryFontFamilies,
  type FontScript,
} from '../src/composables/defaultFontFamilies';

function renderer(available: Record<string, FontScript[]>) {
  return (family: string, script: FontScript) => available[family]?.includes(script) ?? false;
}

describe('fontFamilyKind', () => {
  it('names system keywords and bare generics', () => {
    expect(fontFamilyKind('-apple-system')).toBe('system-ui');
    expect(fontFamilyKind('BlinkMacSystemFont')).toBe('system-ui');
    expect(fontFamilyKind('ui-monospace')).toBe('system-mono');
    expect(fontFamilyKind('sans-serif')).toBe('generic');
    expect(fontFamilyKind('monospace')).toBe('generic');
    expect(fontFamilyKind('Menlo')).toBe('font');
  });
});

describe('parseFontFamilyList', () => {
  it('unquotes and dedupes case-insensitively', () => {
    expect(parseFontFamilyList(`-apple-system, "Segoe UI", 'PingFang SC', segoe ui, sans-serif`)).toEqual([
      '-apple-system',
      'Segoe UI',
      'PingFang SC',
      'sans-serif',
    ]);
  });
});

describe('resolvePrimaryFontFamilies', () => {
  const stack = ['-apple-system', 'Segoe UI', 'system-ui', 'PingFang SC', 'Microsoft YaHei', 'sans-serif', 'Apple Color Emoji'];

  it('names the first Latin font and the first named CJK font', () => {
    expect(
      resolvePrimaryFontFamilies(stack, renderer({ '-apple-system': ['latin', 'cjk'], 'system-ui': ['latin'], 'PingFang SC': ['latin', 'cjk'] })),
    ).toEqual(['-apple-system', 'PingFang SC']);
    expect(
      resolvePrimaryFontFamilies(stack, renderer({ 'Segoe UI': ['latin'], 'system-ui': ['latin'], 'Microsoft YaHei': ['latin', 'cjk'] })),
    ).toEqual(['Segoe UI', 'Microsoft YaHei']);
  });

  it('shows one name when the same font covers both scripts and skips generics', () => {
    expect(resolvePrimaryFontFamilies(['Noto Sans SC', 'sans-serif'], renderer({ 'Noto Sans SC': ['latin', 'cjk'], 'sans-serif': ['latin', 'cjk'] }))).toEqual([
      'Noto Sans SC',
    ]);
    expect(resolvePrimaryFontFamilies(['ui-monospace', 'Menlo', 'monospace'], renderer({ Menlo: ['latin'], monospace: ['latin'] }))).toEqual([
      'Menlo',
    ]);
    expect(resolvePrimaryFontFamilies(['monospace'], renderer({ monospace: ['latin'] }))).toEqual([]);
  });
});
