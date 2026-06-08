import { describe, it, expect } from 'vitest';

import { injectPromptSymbol } from '#/tui/components/editor/custom-editor';

describe('injectPromptSymbol with custom symbol', () => {
  it('places a "$ " prompt when symbol is "$"', () => {
    expect(injectPromptSymbol('    hello world', '$')).toBe('  $ hello world');
  });

  it('preserves overall visible width with custom symbol', () => {
    const original = '    hello       ';
    expect(injectPromptSymbol(original, '$')).toHaveLength(original.length);
  });

  it('returns undefined when the line is too short regardless of symbol', () => {
    expect(injectPromptSymbol('   ', '$')).toBeUndefined();
  });
});

describe('injectPromptSymbol', () => {
  it('places a "> " prompt at columns 2-3 (col 0 = border, col 1 = single-space gap)', () => {
    expect(injectPromptSymbol('    hello world')).toBe('  > hello world');
  });

  it('preserves overall visible width (prompt occupies padding slots)', () => {
    const original = '    hello       ';
    expect(injectPromptSymbol(original)).toHaveLength(original.length);
  });

  it('preserves trailing ANSI escapes (e.g. cursor inverse marker)', () => {
    const line = '    [7m [0m         ';
    const out = injectPromptSymbol(line);
    expect(out).toBe('  > [7m [0m         ');
  });

  it('emits no SGR (terminal default foreground renders the symbol)', () => {
    const out = injectPromptSymbol('    hello');
    expect(out).not.toMatch(/\[/);
  });

  it('returns undefined when the line is too short', () => {
    expect(injectPromptSymbol('   ')).toBeUndefined();
    expect(injectPromptSymbol('')).toBeUndefined();
  });

  it('returns undefined when the leading four characters are not all spaces', () => {
    expect(injectPromptSymbol('x   hello')).toBeUndefined();
    expect(injectPromptSymbol(' x  hello')).toBeUndefined();
    expect(injectPromptSymbol('  x hello')).toBeUndefined();
    expect(injectPromptSymbol('   xhello')).toBeUndefined();
  });
});
