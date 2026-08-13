import { describe, it, expect } from 'vitest';

import { paintHorizontalRules } from '#/tui/components/editor/custom-editor';

const id = (s: string): string => s;

describe('paintHorizontalRules', () => {
  it('keeps the top border a full-width rule (no corners)', () => {
    const out = paintHorizontalRules(['──────────', '   hi     ', '──────────'], id);
    expect(out[0]).toBe('──────────');
    expect(out[0]).toHaveLength(10);
  });

  it('keeps the bottom border a full-width rule (no corners)', () => {
    const out = paintHorizontalRules(['──────────', '   hi     ', '──────────'], id);
    expect(out[2]).toBe('──────────');
  });

  it('leaves content lines untouched so a drag-select copies text only', () => {
    const lines = ['──────────', '   hi     ', '──────────'];
    const out = paintHorizontalRules(lines, id);
    expect(out[1]).toBe('   hi     ');
    expect(out.join('\n')).not.toContain('│');
  });

  it('emits no box glyphs other than the horizontal rule', () => {
    const out = paintHorizontalRules(['─────', '  x  ', '─────'], id).join('\n');
    for (const glyph of ['│', '╭', '╮', '╰', '╯', '├', '┤']) {
      expect(out).not.toContain(glyph);
    }
  });

  it('treats scroll-indicator lines (── ↑ N more ──) as rules and keeps them whole', () => {
    const top = '─── ↑ 5 more ────';
    const bot = '─── ↓ 3 more ────';
    const out = paintHorizontalRules([top, '   x             ', bot], id);
    expect(out[0]).toBe(top);
    expect(out[2]).toBe(bot);
  });

  it('paints autocomplete rows after the bottom border as plain content', () => {
    const lines = ['──────────', '   q      ', '──────────', '   item1  ', '   item2  '];
    const out = paintHorizontalRules(lines, id);
    expect(out[0]).toBe('──────────');
    expect(out[2]).toBe('──────────');
    expect(out[3]).toBe('   item1  ');
    expect(out[4]).toBe('   item2  ');
  });

  it('routes rules through the provided borderColor and leaves content unpainted', () => {
    const paint = (s: string): string => `<${s}>`;
    const out = paintHorizontalRules(['─────', '  x  ', '─────'], paint);
    expect(out[0]).toBe('<─────>');
    expect(out[2]).toBe('<─────>');
    expect(out[1]).toBe('  x  ');
  });

  it('strips the existing SGR of a rule before repainting it', () => {
    const paint = (s: string): string => `<${s}>`;
    const out = paintHorizontalRules(['[31m─────[0m'], paint);
    expect(out[0]).toBe('<─────>');
  });

  it('overlays a label on the top rule, keeping one leading dash', () => {
    const top = '─'.repeat(30);
    const out = paintHorizontalRules([top, '   x   ', top], id, { label: ' ! shell mode ' });
    expect(out[0]).toBe(`─ ! shell mode ${'─'.repeat(15)}`);
    // width is preserved: dash + label + dashes == input width
    expect(out[0]).toHaveLength(top.length);
    // bottom rule is untouched
    expect(out[2]).toBe(top);
  });

  it('does not inject the label when it is wider than the top rule', () => {
    const out = paintHorizontalRules(['──────', '  x  ', '──────'], id, {
      label: ' ! shell mode ',
    });
    // falls back to a plain rule — label must not leak or overflow
    expect(out[0]).toBe('──────');
    expect(out[0]).not.toContain('shell mode');
  });

  it('does not inject the label onto a scroll-indicator top border', () => {
    const top = '─── ↑ 5 more ────';
    const out = paintHorizontalRules([top, '   x             ', '─── ↓ 3 more ────'], id, {
      label: ' ! shell mode ',
    });
    expect(out[0]).toBe(top);
    expect(out[0]).not.toContain('shell mode');
  });

  it('leaves empty lines alone', () => {
    expect(paintHorizontalRules([''], id)).toEqual(['']);
  });
});
