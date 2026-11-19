import { describe, expect, it } from 'vitest';
import { terminalPreviewScreen } from '../src/settings/terminalPreviewScreen';

const plain = (text: string) => text.replace(/\p{Cc}\[[0-9;]*m/gu, '');

describe('terminal preview screen', () => {
  it('shows the directory, complete prompt frame, and model status within the available cells', () => {
    const screen = terminalPreviewScreen(60, 6);
    const lines = screen.lines.map(plain);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('Kimi Code');
    expect(lines[1]).toContain('/Users/moon/moon-landing');
    expect(lines[2]).toMatch(/^╭─+╮$/);
    expect(lines[3]).toMatch(/^│ > +│$/);
    expect(lines[4]).toMatch(/^╰─+╯$/);
    expect(lines[5]).toContain('context: 0% (0/1M)');
    expect(screen.cursorRow).toBe(4);
    expect(screen.cursorColumn).toBe(4);
  });

  it('keeps content and cursor within bounds for narrow or large-font previews', () => {
    for (const columns of [1, 2, 5, 12, 24, 48, 100]) {
      for (const rows of [1, 2, 3, 4, 5, 6, 10]) {
        const screen = terminalPreviewScreen(columns, rows);
        expect(screen.lines.length).toBeLessThanOrEqual(rows);
        for (const line of screen.lines) expect(plain(line).length).toBeLessThanOrEqual(columns);
        expect(screen.cursorRow).toBeGreaterThanOrEqual(1);
        expect(screen.cursorRow).toBeLessThanOrEqual(rows);
        expect(screen.cursorColumn).toBeGreaterThanOrEqual(1);
        expect(screen.cursorColumn).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('prioritizes the input and status when only three rows fit', () => {
    const lines = terminalPreviewScreen(24, 3).lines.map(plain);
    expect(lines[0]).toContain('Kimi Code');
    expect(lines[1]).toBe('> ');
    expect(lines[2]).toContain('Kimi K3.1 Pro');
  });
});
