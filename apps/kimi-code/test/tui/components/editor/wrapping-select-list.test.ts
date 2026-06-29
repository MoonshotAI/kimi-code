import { visibleWidth, type SelectItem, type SelectListTheme } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { WrappingSelectList } from '#/tui/components/editor/wrapping-select-list';

/** Marker theme so assertions can see which style hook painted each part. */
const MARKER_THEME: SelectListTheme = {
  selectedPrefix: (s) => s,
  selectedText: (s) => `[S]${s}`,
  description: (s) => `[D]${s}`,
  scrollInfo: (s) => `[I]${s}`,
  noMatch: (s) => `[N]${s}`,
};

const IDENTITY_THEME: SelectListTheme = {
  selectedPrefix: (s) => s,
  selectedText: (s) => s,
  description: (s) => s,
  scrollInfo: (s) => s,
  noMatch: (s) => s,
};

/** Mirrors pi-tui's slash command layout (editor.js). */
const SLASH_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };

// With two 4-char labels and SLASH_LAYOUT at width 80, the primary column is
// 12 wide: prefix(2) + label(4) + spacing(8) puts descriptions at column 14
// with 64 columns of room (80 - 14 - 2 safety).
const DESCRIPTION_INDENT = ' '.repeat(14);

function makeList(items: SelectItem[], maxVisible = 5): WrappingSelectList {
  return new WrappingSelectList(items, maxVisible, MARKER_THEME, SLASH_LAYOUT);
}

describe('WrappingSelectList', () => {
  it('renders short descriptions on a single line', () => {
    const lines = makeList([
      { value: 'goal', label: 'goal', description: 'First command' },
      { value: 'init', label: 'init', description: 'Second command' },
    ]).render(80);

    expect(lines).toEqual([
      '[S]→ goal        First command',
      '  init[D]        Second command',
    ]);
  });

  it('wraps a long description onto a second indented line without an ellipsis', () => {
    const lines = makeList([
      { value: 'goal', label: 'goal', description: 'First command' },
      {
        value: 'init',
        label: 'init',
        description:
          'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt',
      },
    ]).render(80);

    expect(lines).toEqual([
      '[S]→ goal        First command',
      '  init[D]        lorem ipsum dolor sit amet consectetur adipiscing elit sed do',
      `[D]${DESCRIPTION_INDENT}eiusmod tempor incididunt`,
    ]);
  });

  it('caps descriptions at two lines and ellipsizes the overflow', () => {
    const description = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(4).trim();
    const lines = makeList([
      { value: 'goal', label: 'goal', description: 'First command' },
      { value: 'init', label: 'init', description },
    ]).render(80);

    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^ {2}init\[D\] {8}lorem ipsum/);
    expect(lines[2]).toMatch(new RegExp(`^\\[D\\]${DESCRIPTION_INDENT}`));
    expect(lines[2]!.endsWith('…')).toBe(true);
  });

  it('paints every line of the selected item with the selected style', () => {
    const description = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(4).trim();
    const lines = makeList([
      { value: 'goal', label: 'goal', description },
      { value: 'init', label: 'init', description: 'Second command' },
    ]).render(80);

    expect(lines[0]).toMatch(/^\[S\]→ goal {8}lorem ipsum/);
    expect(lines[1]).toMatch(new RegExp(`^\\[S\\]${DESCRIPTION_INDENT}`));
    expect(lines[2]).toBe('  init[D]        Second command');
  });

  it('falls back to primary-only single lines on narrow widths', () => {
    const lines = makeList([
      { value: 'goal', label: 'goal', description: 'First command' },
      { value: 'init', label: 'init', description: 'Second command' },
    ]).render(40);

    expect(lines).toEqual(['[S]→ goal', '  init']);
  });

  it('keeps the scroll indicator when items overflow maxVisible', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      value: `cmd${i}`,
      label: `cmd${i}`,
      description: 'Short',
    }));
    const lines = makeList(items, 5).render(80);

    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('[I]  (1/7)');
  });

  it('does not leak ANSI resets into themed lines when the primary name is truncated', () => {
    const description = 'Use when about to claim work is complete fixed or passing before committing';
    const lines = makeList([
      { value: 'verify', label: 'skill:verification-before-completion', description },
      { value: 'init', label: 'skill:another-very-long-command-name', description },
    ]).render(80);

    // truncateToWidth appends [0m when it truncates; embedded inside the
    // selected/description colouring it would reset the rest of the line.
    for (const line of lines) {
      expect(line).not.toContain('\u001B');
    }
  });

  it('never emits a line wider than the requested width, including CJK text', () => {
    const list = new WrappingSelectList(
      [
        { value: 'lark', label: 'skill:lark-calendar', description: '管理飞书日历的技能描述'.repeat(8) },
        { value: 'init', label: 'init', description: 'word '.repeat(60).trim() },
      ],
      5,
      IDENTITY_THEME,
      SLASH_LAYOUT,
    );

    for (const line of list.render(80)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });
});
