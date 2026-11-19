import { describe, it, expect } from 'vitest';

import { wrapWithSideBorders } from '#/tui/components/editor/custom-editor';

const id = (s: string): string => s;

describe('wrapWithSideBorders', () => {
  it('turns the top horizontal border into a ╭…╮ run', () => {
    const out = wrapWithSideBorders(['──────────', '   hi     ', '──────────'], id);
    expect(out[0]).toBe('╭────────╮');
  });

  it('turns the top horizontal border into connectors when connected above', () => {
    const out = wrapWithSideBorders(['──────────', '   hi     ', '──────────'], id, {
      connectedAbove: true,
    });
    expect(out[0]).toBe('├────────┤');
    expect(out[2]).toBe('╰────────╯');
  });

  it('turns the bottom horizontal border into a ╰…╯ run', () => {
    const out = wrapWithSideBorders(['──────────', '   hi     ', '──────────'], id);
    expect(out[2]).toBe('╰────────╯');
  });

  it('wraps content lines with │ … │, replacing the outer padding columns', () => {
    const out = wrapWithSideBorders(['──────────', '   hi     ', '──────────'], id);
    expect(out[1]).toBe('│  hi    │');
    expect(out[1]).toHaveLength('   hi     '.length);
  });

  it('treats scroll-indicator lines (── ↑ N more ──) as horizontal borders', () => {
    const top = '─── ↑ 5 more ────';
    const bot = '─── ↓ 3 more ────';
    const out = wrapWithSideBorders([top, '   x             ', bot], id);
    expect(out[0]?.startsWith('╭')).toBe(true);
    expect(out[0]?.endsWith('╮')).toBe(true);
    expect(out[2]?.startsWith('╰')).toBe(true);
    expect(out[2]?.endsWith('╯')).toBe(true);
    expect(out[0]).toContain('↑ 5 more');
    expect(out[2]).toContain('↓ 3 more');
  });

  it('handles autocomplete rows that come after the bottom border (still wrap with │)', () => {
    const lines = [
      '──────────',
      '   q      ',
      '──────────',
      '   item1  ',
      '   item2  ',
    ];
    const out = wrapWithSideBorders(lines, id);
    expect(out[0]?.startsWith('╭')).toBe(true);
    expect(out[2]?.startsWith('╰')).toBe(true);
    expect(out[3]).toBe('│  item1 │');
    expect(out[4]).toBe('│  item2 │');
  });

  it('paints corners and side borders through the provided borderColor', () => {
    const paint = (s: string): string => `<${s}>`;
    const out = wrapWithSideBorders(['─────', '  x  ', '─────'], paint);
    expect(out[0]).toBe('<╭───╮>');
    expect(out[2]).toBe('<╰───╯>');
    expect(out[1]).toBe('<│> x <│>');
  });

  it('does not clobber non-space content sitting in the outer column (e.g. cursor overflow)', () => {
    const out = wrapWithSideBorders(['─────', '  abc', '─────'], id);
    expect(out[1]).toBe('│ abc');
  });

  it('overlays a label on the top border, replacing leading dashes', () => {
    const top = '─'.repeat(30);
    const out = wrapWithSideBorders([top, '   x   ', top], id, { label: ' ! shell mode ' });
    expect(out[0]).toBe(`╭ ! shell mode ${'─'.repeat(14)}╮`);
    expect(out[0]).toHaveLength(top.length);
    expect(out[2]).toBe(`╰${'─'.repeat(28)}╯`);
  });

  it('does not inject the label when it is wider than the top border', () => {
    const out = wrapWithSideBorders(['──────', '  x  ', '──────'], id, {
      label: ' ! shell mode ',
    });
    expect(out[0]).toBe('╭────╮');
    expect(out[0]).not.toContain('shell mode');
  });

  it('does not inject the label onto a scroll-indicator top border', () => {
    const top = '─── ↑ 5 more ────';
    const out = wrapWithSideBorders([top, '   x             ', '─── ↓ 3 more ────'], id, {
      label: ' ! shell mode ',
    });
    expect(out[0]).toContain('↑ 5 more');
    expect(out[0]).not.toContain('shell mode');
  });
});
