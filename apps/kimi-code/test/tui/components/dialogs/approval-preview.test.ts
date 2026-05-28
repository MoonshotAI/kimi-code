import type { Terminal } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import {
  ApprovalPreviewViewer,
  type ApprovalPreviewBlock,
} from '#/tui/components/dialogs/approval-preview';
import { getColorPalette } from '#/tui/theme/colors';

const COLORS = getColorPalette('dark');

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
      colors: COLORS,
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

  // The whole point of the viewer: a long Write file content stays accessible
  // by paging, not by inflating the approval panel inline.
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

    viewer.handleInput('[6~'); // PageDown
    viewer.handleInput('[6~');
    viewer.handleInput('[6~');

    const scrolled = strip(viewer.render(100).join('\n'));
    expect(scrolled).not.toContain('row-1\n'); // start of file is gone
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

  // Both esc and ctrl+e close — ctrl+e is the same key that opened the
  // viewer, so making it a toggle keeps the muscle memory simple.
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

  // Sanity: rendering is a pure slice — repeated render() calls without
  // input changes produce the same output, no incremental state drift.
  it('renders deterministically across repeated calls', () => {
    const viewer = makeViewer({
      block: { type: 'file_content', path: 'a.ts', content: 'one\ntwo\nthree' },
    });
    const first = viewer.render(80).join('\n');
    const second = viewer.render(80).join('\n');
    expect(first).toBe(second);
  });
});
