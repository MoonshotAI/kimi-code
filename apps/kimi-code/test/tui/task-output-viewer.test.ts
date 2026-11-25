import { TuiAltScreen, stripTerminalSequences, visibleWidth, type Terminal } from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { TaskOutputViewer } from '@/tui/components/dialogs/task-output-viewer';
import { beginScreenTakeover, endScreenTakeover } from '#/tui/utils/screen-takeover';

import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';

const ANSI_SGR = /\[[0-9;]*m/g;
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

function info(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    taskId: 'bash-aaaaaaaa',
    kind: 'process',
    command: 'npm run dev',
    description: 'dev server',
    status: 'running',
    pid: 1234,
    exitCode: null,
    startedAt: Date.now() - 60_000,
    endedAt: null,
    ...overrides,
  } as BackgroundTaskInfo;
}

function makeViewer(opts: {
  output: string;
  taskInfo?: BackgroundTaskInfo;
  rows?: number;
  columns?: number;
  onClose?: () => void;
}): TaskOutputViewer {
  return new TaskOutputViewer(
    {
      taskId: opts.taskInfo?.taskId ?? 'bash-aaaaaaaa',
      info: opts.taskInfo ?? info(),
      output: opts.output,
      onClose: opts.onClose ?? (() => {}),
    },
    fakeTerminal(opts.rows ?? 30, opts.columns ?? 120),
  );
}

describe('TaskOutputViewer — rendering', () => {
  it('fills exactly terminal.rows lines', () => {
    const lines = makeViewer({ output: 'hello\nworld', rows: 24 }).render(120);
    expect(lines.length).toBe(24);
  });

  it('shows the task header (id + status + description)', () => {
    const out = strip(
      makeViewer({
        output: '',
        taskInfo: info({ taskId: 'bash-zzzzzzzz', status: 'running', description: 'demo svc' }),
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('Task output');
    expect(out).toContain('bash-zzzzzzzz');
    expect(out).toContain('running');
    expect(out).toContain('demo svc');
  });

  it('shows the empty-state body when output is empty', () => {
    const out = strip(makeViewer({ output: '' }).render(120).join('\n'));
    expect(out).toContain('[no output captured]');
  });

  it('shows position indicator in the footer', () => {
    const lines = ['line 1', 'line 2', 'line 3'].join('\n');
    const out = strip(makeViewer({ output: lines, rows: 20 }).render(120).join('\n'));
    expect(out).toMatch(/1-3 \/ 3/);
    expect(out).toContain('100%');
  });

  it('renders all visible body lines when output fits the body height', () => {
    const lines = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].join('\n');
    const out = strip(makeViewer({ output: lines, rows: 20 }).render(120).join('\n'));
    expect(out).toContain('alpha');
    expect(out).toContain('bravo');
    expect(out).toContain('charlie');
    expect(out).toContain('delta');
    expect(out).toContain('echo');
  });

  it('does not pass terminal controls from task output into the framed body', () => {
    const rendered = makeViewer({
      output: 'Downloading wheel 25%\rDownloading wheel 75%\u001B[2Jdone',
    }).render(120);
    const raw = rendered.join('\n');

    expect(raw).not.toContain('\r');
    expect(raw).not.toContain('\u001B[2J');
    expect(strip(raw)).toContain('Downloading wheel 25%Downloading wheel 75%done');
  });
});

describe('TaskOutputViewer — scrolling', () => {
  function bigOutput(n: number): string {
    return Array.from({ length: n }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`).join('\n');
  }

  it('renders the top of the buffer initially', () => {
    const viewer = makeViewer({ output: bigOutput(100), rows: 20 });
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-001');
    expect(out).not.toContain('line-100');
  });

  it('down arrow scrolls forward by one line', () => {
    const viewer = makeViewer({ output: bigOutput(50), rows: 12 });
    viewer.handleInput('[B');
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-002');
    expect(out).not.toContain('line-001');
  });

  it('PageDown scrolls a page', () => {
    const viewer = makeViewer({ output: bigOutput(50), rows: 12 });
    viewer.handleInput('[6~');
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-008');
    expect(out).not.toContain('line-001');
  });

  it('Ctrl+D scrolls a page down', () => {
    const viewer = makeViewer({ output: bigOutput(50), rows: 12 });
    viewer.handleInput('\u0004');
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-008');
    expect(out).not.toContain('line-001');
  });

  it('Ctrl+U scrolls a page up', () => {
    const viewer = makeViewer({ output: bigOutput(50), rows: 12 });
    viewer.handleInput('G');
    viewer.handleInput('\u0015');
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-036');
    expect(out).not.toContain('line-050');
  });

  it('G jumps to the bottom', () => {
    const viewer = makeViewer({ output: bigOutput(100), rows: 14 });
    viewer.handleInput('G');
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-100');
    expect(out).toContain('100%');
  });

  it('g jumps back to the top', () => {
    const viewer = makeViewer({ output: bigOutput(100), rows: 14 });
    viewer.handleInput('G');
    viewer.handleInput('g');
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-001');
  });

  it('scrolling clamps at the start and end', () => {
    const viewer = makeViewer({ output: bigOutput(5), rows: 20 });
    viewer.handleInput('[B');
    viewer.handleInput('[B');
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-001');
    expect(out).toContain('line-005');
  });
});

describe('TaskOutputViewer — input', () => {
  it('Esc invokes onClose', () => {
    const onClose = vi.fn();
    makeViewer({ output: 'x', onClose }).handleInput('');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('q invokes onClose', () => {
    const onClose = vi.fn();
    makeViewer({ output: 'x', onClose }).handleInput('q');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Kitty-encoded q invokes onClose', () => {
    const onClose = vi.fn();
    makeViewer({ output: 'x', onClose }).handleInput('\u001B[113u');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Kitty-encoded G scrolls to bottom', () => {
    const viewer = makeViewer({
      output: Array.from({ length: 200 }, (_, i) => `line-${String(i)}`).join('\n'),
      rows: 10,
    });
    viewer.handleInput('\u001B[71u');
    const rendered = strip(viewer.render(120).join('\n'));
    expect(rendered).toContain('line-199');
  });
});

describe('TaskOutputViewer — live tail via setProps', () => {
  function makeOutput(n: number): string {
    return Array.from({ length: n }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`).join('\n');
  }

  it('follows new lines when the viewer is already parked at the bottom', () => {
    const viewer = makeViewer({ output: makeOutput(5), rows: 30 });
    viewer.handleInput('G');
    viewer.setProps({
      taskId: 'bash-aaaaaaaa',
      info: info(),
      output: makeOutput(50),
      onClose: () => {},
    });
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-050');
  });

  it('preserves scroll position when the user has scrolled up', () => {
    const viewer = makeViewer({ output: makeOutput(100), rows: 14 });
    expect(strip(viewer.render(120).join('\n'))).toContain('line-001');
    viewer.setProps({
      taskId: 'bash-aaaaaaaa',
      info: info(),
      output: makeOutput(200),
      onClose: () => {},
    });
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-001');
    expect(out).not.toContain('line-200');
  });

  it('skips re-split when output is unchanged', () => {
    const same = makeOutput(20);
    const viewer = makeViewer({ output: same, rows: 30 });
    viewer.handleInput('G');
    const before = strip(viewer.render(120).join('\n'));
    viewer.setProps({
      taskId: 'bash-aaaaaaaa',
      info: info(),
      output: same,
      onClose: () => {},
    });
    const after = strip(viewer.render(120).join('\n'));
    expect(after).toBe(before);
  });
});

describe('TaskOutputViewer — fullscreen mouse and scrollbar', () => {
  function bigOutput(n: number): string {
    return Array.from({ length: n }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`).join('\n');
  }

  it('omits scrollbar glyphs in direct regular-mode render', () => {
    const viewer = makeViewer({ output: bigOutput(60), rows: 14 });
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
  });

  it('supports mouse wheel, scrollbar drag inside frame rails, resize, and clickable footer close in TuiAltScreen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);

    const onClose = vi.fn();
    const width = 80;
    const height = 14;
    const vt = new VirtualTerminal(width, height);
    const ui = new TuiAltScreen(vt);
    const viewer = new TaskOutputViewer(
      {
        taskId: 'bash-aaaaaaaa',
        info: info(),
        output: bigOutput(60),
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
    expect(initial.join('\n')).toContain('line-001');
    expect(initial[1]![0]).toBe('╭');
    expect(initial[1]![width - 1]).toBe('╮');
    const bodyRows = initial.slice(2, height - 2);
    for (const row of bodyRows) {
      expect(row[0]).toBe('│');
      expect(row[width - 1]).toBe('│');
    }
    expect(bodyRows.some((row) => row[width - 2] === '┃' || row[width - 2] === '│')).toBe(true);

    for (let i = 0; i < 6; i++) {
      vt.sendInput('\u001B[<65;20;5M');
    }
    await vt.waitForRender();
    const afterWheelDown = readRows();
    expect(afterWheelDown.join('\n')).not.toContain('line-001');
    expect(afterWheelDown.join('\n')).toContain('line-007');

    const scrollbarCol = width - 1;
    vt.sendInput(`\u001B[<0;${String(scrollbarCol)};3M`);
    vt.sendInput(`\u001B[<32;${String(scrollbarCol)};${String(height - 2)}M`);
    vt.sendInput(`\u001B[<0;${String(scrollbarCol)};${String(height - 2)}m`);
    await vt.waitForRender();
    const afterDrag = readRows();
    expect(afterDrag.join('\n')).toContain('line-060');
    for (const row of afterDrag.slice(2, height - 2)) {
      expect(row[width - 1]).toBe('│');
    }

    vt.resize(width, 20);
    await vt.waitForRender();
    const resized = readRows();
    expect(resized).toHaveLength(20);
    for (const row of resized.slice(2, 18)) {
      expect(row[0]).toBe('│');
      expect(row[width - 1]).toBe('│');
    }

    const footerRow = 20;
    const cancelCol = resized[19]!.indexOf('Q/Esc');
    expect(cancelCol).toBeGreaterThan(0);

    vt.sendInput(`\u001B[<0;${String(cancelCol + 1)};${String(footerRow)}M`);
    vt.sendInput(`\u001B[<0;${String(cancelCol + 1)};${String(footerRow)}m`);
    await vt.waitForRender();
    expect(onClose).not.toHaveBeenCalled();

    ui.setFocus(null);
    expect(viewer.focused).toBe(false);
    vi.setSystemTime(10_400);
    vt.sendInput(`\u001B[<0;${String(cancelCol + 1)};${String(footerRow)}M`);
    vt.sendInput(`\u001B[<0;${String(cancelCol + 1)};${String(footerRow)}m`);
    await vt.waitForRender();
    expect(ui.getFocusedComponent()).toBe(viewer);
    expect(viewer.focused).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    vt.sendInput(`\u001B[<0;${String(cancelCol + 1)};${String(footerRow)}M`);
    vt.sendInput(`\u001B[<0;${String(cancelCol + 1)};${String(footerRow)}m`);
    await vt.waitForRender();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ui.getFocusedComponent()).toBe(viewer);
  });
});
