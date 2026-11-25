import { TuiAltScreen, stripTerminalSequences, visibleWidth, type Terminal } from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  ApprovalPreviewViewer,
  type ApprovalPreviewBlock,
} from '#/tui/components/dialogs/approval-preview';
import { beginScreenTakeover, endScreenTakeover } from '#/tui/utils/screen-takeover';

import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';
const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function fakeTerminal(rows: number, columns = 120): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
    setProgramStatus: () => {},
  };
}

function makeViewer(opts: {
  block: ApprovalPreviewBlock;
  rows?: number;
  columns?: number;
  onClose?: () => void;
}): ApprovalPreviewViewer {
  return new ApprovalPreviewViewer(
    {
      block: opts.block,
      onClose: opts.onClose ?? (() => {}),
    },
    fakeTerminal(opts.rows ?? 24, opts.columns ?? 100),
  );
}

describe('ApprovalPreviewViewer', () => {
  it('fills exactly terminal.rows lines', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 50; i++) lines.push(`line ${String(i)}`);
    const viewer = makeViewer({
      block: { type: 'file_content', path: 'src/big.ts', content: lines.join('\n') },
      rows: 24,
    });
    expect(viewer.render(100).length).toBe(24);
  });

  it('reveals later lines of a long file_content after PageDown', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 200; i++) lines.push(`row-${String(i)}`);
    const viewer = makeViewer({
      block: { type: 'file_content', path: 'src/big.ts', content: lines.join('\n') },
      rows: 24,
    });

    const initial = strip(viewer.render(100).join('\n'));
    expect(initial).toContain('row-1');
    expect(initial).not.toContain('row-150');

    viewer.handleInput('[6~');
    viewer.handleInput('[6~');
    viewer.handleInput('[6~');

    const scrolled = strip(viewer.render(100).join('\n'));
    expect(scrolled).not.toContain('row-1\n');
    expect(scrolled).toMatch(/row-\d{2,}/);
  });

  it('scrolls to the end with G and back to the top with g', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) lines.push(`L${String(i)}`);
    const viewer = makeViewer({
      block: { type: 'file_content', path: 'src/x.ts', content: lines.join('\n') },
      rows: 20,
    });

    viewer.handleInput('G');
    const atEnd = strip(viewer.render(100).join('\n'));
    expect(atEnd).toContain('L100');

    viewer.handleInput('g');
    const atTop = strip(viewer.render(100).join('\n'));
    expect(atTop).toContain('L1');
    expect(atTop).not.toContain('L100');
  });

  it.each([
    ['escape', ''],
    ['ctrl+e', ''],
    ['q', 'q'],
  ])('%s closes the viewer', (_label, key) => {
    let closed = 0;
    const viewer = makeViewer({
      block: { type: 'file_content', path: 'a.ts', content: 'x' },
      onClose: () => closed++,
    });
    viewer.handleInput(key);
    expect(closed).toBe(1);
  });

  it('renders a diff block with +N -M header and both sides of the hunk', () => {
    const viewer = makeViewer({
      block: {
        type: 'diff',
        path: 'src/foo.ts',
        old_text: 'alpha\nbeta\ngamma',
        new_text: 'alpha\nBETA\ngamma',
      },
      rows: 24,
    });

    const text = strip(viewer.render(100).join('\n'));
    expect(text).toContain('src/foo.ts');
    expect(text).toContain('+1');
    expect(text).toContain('-1');
    expect(text).toContain('beta');
    expect(text).toContain('BETA');
  });

  it('shows surrounding context lines for a diff block', () => {
    const viewer = makeViewer({
      block: {
        type: 'diff',
        path: 'src/foo.ts',
        old_text: ['before1', 'before2', 'old', 'after1', 'after2'].join('\n'),
        new_text: ['before1', 'before2', 'new', 'after1', 'after2'].join('\n'),
      },
      rows: 24,
    });

    const text = strip(viewer.render(100).join('\n'));
    expect(text).toContain('before1');
    expect(text).toContain('before2');
    expect(text).toContain('old');
    expect(text).toContain('new');
    expect(text).toContain('after1');
    expect(text).toContain('after2');
  });

  it('renders deterministically across repeated calls', () => {
    const viewer = makeViewer({
      block: { type: 'file_content', path: 'a.ts', content: 'one\ntwo\nthree' },
    });
    const first = viewer.render(80).join('\n');
    const second = viewer.render(80).join('\n');
    expect(first).toBe(second);
  });

  it('omits scrollbar glyphs in direct regular-mode render and supports Ctrl+D / Ctrl+U paging', () => {
    const content = Array.from({ length: 80 }, (_, i) => `row-${String(i + 1)}`).join('\n');
    const viewer = makeViewer({
      block: { type: 'file_content', path: 'src/big.ts', content },
      rows: 14,
    });
    const rawRows = viewer.render(80);
    expect(rawRows).toHaveLength(14);
    for (const rawRow of rawRows.slice(2, -2)) {
      expect(visibleWidth(rawRow)).toBe(80);
      const row = stripTerminalSequences(rawRow);
      expect(row.startsWith('│ ')).toBe(true);
      expect(row.endsWith(' │')).toBe(true);
      expect(row[78]).toBe(' ');
      expect(row).not.toMatch(/[┃█]/);
    }

    viewer.handleInput('\u0004');
    const down = strip(viewer.render(80).join('\n'));
    expect(down).not.toContain('row-1\n');
    expect(down).toContain('row-10');

    viewer.handleInput('\u0015');
    const backUp = strip(viewer.render(80).join('\n'));
    expect(backUp).toContain('row-1');
  });

  it('supports mouse wheel, scrollbar inside rails, focus restoration, and clickable close in TuiAltScreen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);

    const onClose = vi.fn();
    const width = 90;
    const height = 14;
    const vt = new VirtualTerminal(width, height);
    const ui = new TuiAltScreen(vt);
    const content = Array.from({ length: 80 }, (_, i) => `preview-line-${String(i + 1)}`).join('\n');
    const viewer = new ApprovalPreviewViewer(
      {
        block: { type: 'file_content', path: 'src/big.ts', content },
        onClose,
      },
      vt,
    );

    const takeover = beginScreenTakeover(ui, viewer);
    ui.setFocus(viewer);
    ui.start();
    onTestFinished(() => {
      endScreenTakeover(ui, takeover);
      ui.stop();
      vi.useRealTimers();
    });
    await vt.waitForRender();

    const readRows = (): string[] => vt.getViewport().map(strip);

    const initial = readRows();
    expect(initial.join('\n')).toContain('preview-line-1');
    const bodyRows = initial.slice(2, height - 2);
    for (const row of bodyRows) {
      expect(row[0]).toBe('│');
      expect(row[width - 1]).toBe('│');
    }
    expect(bodyRows.some((row) => row[width - 2] === '┃' || row[width - 2] === '│')).toBe(true);

    for (let i = 0; i < 8; i++) {
      vt.sendInput('\u001B[<65;20;5M');
    }
    await vt.waitForRender();
    const afterWheel = readRows();
    expect(afterWheel.join('\n')).not.toContain('preview-line-1\n');
    expect(afterWheel.join('\n')).toContain('preview-line-10');

    const cancelCol = afterWheel[height - 1]!.indexOf('Q/Esc/Ctrl+E');
    expect(cancelCol).toBeGreaterThan(0);

    ui.setFocus(null);
    expect(viewer.focused).toBe(false);
    vi.setSystemTime(10_400);
    vt.sendInput(`\u001B[<0;${String(cancelCol + 1)};${String(height)}M`);
    vt.sendInput(`\u001B[<0;${String(cancelCol + 1)};${String(height)}m`);
    await vt.waitForRender();
    expect(ui.getFocusedComponent()).toBe(viewer);
    expect(viewer.focused).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    vt.sendInput(`\u001B[<0;${String(cancelCol + 1)};${String(height)}M`);
    vt.sendInput(`\u001B[<0;${String(cancelCol + 1)};${String(height)}m`);
    await vt.waitForRender();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ui.getFocusedComponent()).toBe(viewer);
  });
});
