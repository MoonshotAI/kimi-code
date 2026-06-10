import { describe, expect, it } from 'vitest';

import {
  computeDiffLines,
  renderDiffLines,
  renderDiffLinesClustered,
} from '#/tui/components/media/diff-preview';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('computeDiffLines', () => {
  it('renders a complete diff when isIncomplete is false', () => {
    const lines = computeDiffLines('A\nB\nC\nD', 'A\nB', 1, 1, false);
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toEqual(['context', 'context', 'delete', 'delete']);
  });

  it('suppresses trailing deletes when isIncomplete is true', () => {
    const lines = computeDiffLines('A\nB\nC\nD', 'A\nB', 1, 1, true);
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toEqual(['context', 'context']);
  });

  it('suppresses all deletes when everything would be deleted and incomplete', () => {
    const lines = computeDiffLines('A\nB\nC', '', 1, 1, true);
    expect(lines).toEqual([]);
  });

  it('keeps trailing adds when isIncomplete is true', () => {
    const lines = computeDiffLines('A\nB\nC', 'A\nB\nX', 1, 1, true);
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toEqual(['context', 'context', 'delete', 'add']);
  });

  it('keeps internal delete blocks that are not trailing', () => {
    const lines = computeDiffLines('A\nB\nC\nD', 'A\nC', 1, 1, true);
    const kinds = lines.map((l) => l.kind);
    expect(kinds).toEqual(['context', 'delete', 'context']);
  });
});

describe('renderDiffLines', () => {
  it('does not show removed count for suppressed trailing deletes', () => {
    const output = renderDiffLines('A\nB\nC\nD', 'A\nB', 'test.ts', true, 1, 1);
    const text = stripAnsi(output.join('\n'));
    expect(text).toContain('test.ts');
    expect(text).not.toContain('-2');
    expect(text).not.toContain('C');
    expect(text).not.toContain('D');
    // When trailing deletes are suppressed, only context lines remain;
    // renderDiffLines only emits changed lines, so the body is empty.
    expect(text).not.toContain('A');
    expect(text).not.toContain('B');
  });

  it('shows removed count for complete diffs', () => {
    const output = renderDiffLines('A\nB\nC\nD', 'A\nB', 'test.ts', false, 1, 1);
    const text = stripAnsi(output.join('\n'));
    expect(text).toContain('-2');
    expect(text).toContain('C');
    expect(text).toContain('D');
  });
});

describe('renderDiffLinesClustered', () => {
  it('renders header with file path and counts', () => {
    const out = renderDiffLinesClustered('A\nB\nC', 'A\nX\nC', 'foo.ts');
    const text = stripAnsi(out[0]!);
    expect(text).toContain('+1');
    expect(text).toContain('-1');
    expect(text).toContain('foo.ts');
  });

  it('returns header only when there are no changes', () => {
    const out = renderDiffLinesClustered('A\nB', 'A\nB', 'foo.ts');
    expect(out).toHaveLength(1);
    expect(stripAnsi(out[0]!)).toContain('foo.ts');
  });

  it('shows context lines around a single change cluster', () => {
    // Five lines, change line 3 only — context is 1 each side.
    const oldText = ['L1', 'L2', 'L3', 'L4', 'L5'].join('\n');
    const newText = ['L1', 'L2', 'L3X', 'L4', 'L5'].join('\n');
    const text = stripAnsi(
      renderDiffLinesClustered(oldText, newText, 'f.ts', { contextLines: 1 }).join('\n'),
    );
    expect(text).toContain('L2');
    expect(text).toContain('L3');
    expect(text).toContain('L3X');
    expect(text).toContain('L4');
    expect(text).not.toContain('L1');
    expect(text).not.toContain('L5');
  });

  it('elides unchanged middle between two clusters with a separator', () => {
    const oldLines: string[] = [];
    for (let i = 1; i <= 30; i++) oldLines.push(`L${String(i)}`);
    const newLines = oldLines.slice();
    newLines[1] = 'L2X'; // change near top
    newLines[28] = 'L29X'; // change near bottom
    const text = stripAnsi(
      renderDiffLinesClustered(oldLines.join('\n'), newLines.join('\n'), 'f.ts', {
        contextLines: 2,
      }).join('\n'),
    );
    expect(text).toContain('L2X');
    expect(text).toContain('L29X');
    expect(text).toMatch(/… \d+ unchanged lines? …/);
    // Middle untouched lines (e.g. L15) should not appear.
    expect(text).not.toContain('L15');
  });

  it('merges nearby change clusters when the gap is within context window', () => {
    const oldLines: string[] = [];
    for (let i = 1; i <= 10; i++) oldLines.push(`L${String(i)}`);
    const newLines = oldLines.slice();
    newLines[2] = 'L3X';
    newLines[5] = 'L6X'; // gap of 2 lines between change indices 2 and 5 → merges with contextLines=2 (mergeGap=4)
    const out = renderDiffLinesClustered(oldLines.join('\n'), newLines.join('\n'), 'f.ts', {
      contextLines: 2,
    }).join('\n');
    const text = stripAnsi(out);
    expect(text).not.toMatch(/unchanged lines? …/);
    expect(text).toContain('L3X');
    expect(text).toContain('L6X');
  });

  it('emits a partial body even when a single cluster exceeds maxLines', () => {
    // Worst case from prod: 100 lines fully replaced inline → single huge
    // cluster of ~200 diff entries. With maxLines=10 the renderer must
    // still emit ~10 leading body rows, not just the truncation footer.
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      oldLines.push(`old${String(i)}`);
      newLines.push(`new${String(i)}`);
    }
    const out = renderDiffLinesClustered(
      oldLines.join('\n'),
      newLines.join('\n'),
      'big.ts',
      {
        contextLines: 3,
        maxLines: 10,
      },
    );
    // header + 10 body rows + truncation footer
    expect(out.length).toBe(12);
    const text = stripAnsi(out.join('\n'));
    expect(text).toContain('+100');
    expect(text).toContain('-100');
    expect(text).toMatch(/old\d+|new\d+/);
    expect(text).toContain('ctrl+o to expand');
  });

  it('truncates at cluster boundary and appends the ctrl+o footer when maxLines is set', () => {
    const oldLines: string[] = [];
    for (let i = 1; i <= 50; i++) oldLines.push(`L${String(i)}`);
    const newLines = oldLines.slice();
    newLines[1] = 'L2X';
    newLines[20] = 'L21X';
    newLines[40] = 'L41X';
    const text = stripAnsi(
      renderDiffLinesClustered(oldLines.join('\n'), newLines.join('\n'), 'f.ts', {
        contextLines: 2,
        maxLines: 6,
      }).join('\n'),
    );
    expect(text).toContain('L2X');
    expect(text).toMatch(/more change/);
    expect(text).toContain('ctrl+o to expand');
    expect(text).not.toContain('L41X');
  });
});
