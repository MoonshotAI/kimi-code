import { describe, it, expect } from 'vitest';

import { injectPromptSymbol } from '#/tui/components/editor/custom-editor';

describe('injectPromptSymbol', () => {
  it('places the "> " prompt at columns 0-1, flush against the left edge', () => {
    expect(injectPromptSymbol('  hello world')).toBe('> hello world');
  });

  it('preserves overall visible width (prompt occupies the padding slots)', () => {
    const original = '  hello       ';
    expect(injectPromptSymbol(original)).toHaveLength(original.length);
  });

  it('preserves trailing ANSI escapes (e.g. cursor inverse marker)', () => {
    const line = '  [7m [0m         ';
    const out = injectPromptSymbol(line);
    expect(out).toBe('> [7m [0m         ');
  });

  it('emits no SGR (terminal default foreground renders the symbol)', () => {
    const out = injectPromptSymbol('  hello');
    // oxlint-disable-next-line no-control-regex -- ESC () is required to match ANSI SGR escape sequences
    expect(out).not.toMatch(/\[/);
  });

  it('paints the symbol when a paint function is supplied (bash mode)', () => {
    expect(injectPromptSymbol('  ls -la', '!', (s) => `<${s}>`)).toBe('<!> ls -la');
  });

  it('returns undefined when the line is too short', () => {
    expect(injectPromptSymbol(' ')).toBeUndefined();
    expect(injectPromptSymbol('')).toBeUndefined();
  });

  it('returns undefined when the leading two characters are not both spaces', () => {
    expect(injectPromptSymbol('x hello')).toBeUndefined();
    expect(injectPromptSymbol(' xhello')).toBeUndefined();
  });
});
