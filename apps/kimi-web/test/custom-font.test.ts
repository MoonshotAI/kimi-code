import { describe, expect, it } from 'vitest';
import { sanitizeCustomFontInput, toFontFamilyList } from '../src/lib/customFont';

describe('sanitizeCustomFontInput', () => {
  it('keeps plain font names untouched', () => {
    expect(sanitizeCustomFontInput('Maple Mono NF CN')).toBe('Maple Mono NF CN');
  });

  it('strips quotes, backslashes, semicolons and braces', () => {
    expect(sanitizeCustomFontInput('"Maple"; } { \\')).toBe('Maple');
    expect(sanitizeCustomFontInput("it's")).toBe('its');
  });

  it('caps the length at 200 chars', () => {
    expect(sanitizeCustomFontInput('a'.repeat(300))).toHaveLength(200);
  });
});

describe('toFontFamilyList', () => {
  it('quotes a single family name', () => {
    expect(toFontFamilyList('Maple Mono NF CN')).toBe('"Maple Mono NF CN"');
  });

  it('collapses repeated whitespace inside a name', () => {
    expect(toFontFamilyList('Maple   Mono')).toBe('"Maple Mono"');
  });

  it('handles comma-separated fallbacks', () => {
    expect(toFontFamilyList('Foo Bar, Baz')).toBe('"Foo Bar", "Baz"');
  });

  it('passes generic keywords through unquoted and lowercased', () => {
    expect(toFontFamilyList('Monospace')).toBe('monospace');
    expect(toFontFamilyList('My Font, SYSTEM-UI')).toBe('"My Font", system-ui');
  });

  it('drops empty segments', () => {
    expect(toFontFamilyList(' , ')).toBe('');
    expect(toFontFamilyList('Foo,,Bar,')).toBe('"Foo", "Bar"');
  });

  it('sanitizes before quoting', () => {
    expect(toFontFamilyList('a"; color:red')).toBe('"a color:red"');
  });
});
