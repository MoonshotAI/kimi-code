import { describe, expect, it } from 'vitest';

import { buildDiffWindow, diffGutter } from '#/tui/utils/review-diff';

const DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,6 +1,7 @@',
  ' line1',
  ' line2',
  ' line3',
  '-old4',
  '+new4',
  '+new5',
  ' line6',
  ' line7',
  '',
].join('\n');

describe('buildDiffWindow', () => {
  it('windows around the anchor within its hunk', () => {
    const window = buildDiffWindow(DIFF, { path: 'src/foo.ts', side: 'new', line: 4 }, 2);
    expect(window.found).toBe(true);
    const anchorRow = window.rows[window.anchorIndex]!;
    expect(anchorRow).toMatchObject({ kind: 'add', newLine: 4, text: 'new4' });
    // ±2 rows around the anchor at index 4: line3, old4, new4, new5, line6.
    expect(window.rows.map((row) => row.text)).toEqual(['line3', 'old4', 'new4', 'new5', 'line6']);
  });

  it('reports not-found and shows the first hunk when the anchor is missing', () => {
    const window = buildDiffWindow(DIFF, { path: 'src/foo.ts', side: 'new', line: 999 });
    expect(window.found).toBe(false);
    expect(window.anchorIndex).toBe(-1);
    expect(window.rows.length).toBeGreaterThan(0);
  });

  it('returns an empty window for an unknown file', () => {
    const window = buildDiffWindow(DIFF, { path: 'nope.ts', side: 'new', line: 1 });
    expect(window).toEqual({ rows: [], anchorIndex: -1, found: false });
  });
});

describe('diffGutter', () => {
  it('renders the line number and change marker', () => {
    expect(diffGutter({ kind: 'add', newLine: 4, text: 'x' }, 3)).toBe('  4 +');
    expect(diffGutter({ kind: 'del', oldLine: 4, text: 'x' }, 3)).toBe('  4 -');
    expect(diffGutter({ kind: 'context', oldLine: 3, newLine: 3, text: 'x' }, 3)).toBe('  3  ');
  });
});
