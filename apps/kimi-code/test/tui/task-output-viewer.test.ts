import type { Terminal } from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { TaskOutputViewer } from '@/tui/components/dialogs/task-output-viewer';
import { darkColors } from '@/tui/theme/colors';

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
    // PageDown via prompt-toolkit-style sequence "[6~"
    viewer.handleInput('[6~');
    const out = strip(viewer.render(120).join('\n'));
    // body has 12 - 2 (header/footer) - 2 (top/bot border) = 8 viewable rows.
    // PageDown shifts by (body - 1) = 7 lines.
    expect(out).toContain('line-008');
    expect(out).not.toContain('line-001');
  });

  it('Ctrl+D scrolls a page down', () => {
    const viewer = makeViewer({ output: bigOutput(50), rows: 12 });
    viewer.handleInput('\u0004'); // Ctrl+D
    const out = strip(viewer.render(120).join('\n'));
    // Same page size as PageDown: body has 8 viewable rows, page = 7 lines.
    expect(out).toContain('line-008');
    expect(out).not.toContain('line-001');
  });

  it('Ctrl+U scrolls a page up', () => {
    const viewer = makeViewer({ output: bigOutput(50), rows: 12 });
    viewer.handleInput('G'); // jump to bottom first
    viewer.handleInput('\u0015'); // Ctrl+U
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-036');
    expect(out).not.toContain('line-050');
  });

  it('G jumps to the bottom', () => {
    const viewer = makeViewer({ output: bigOutput(100), rows: 14 });
    viewer.handleInput('G');
    const out = strip(viewer.render(120).join('\n'));
    expect(out).toContain('line-100');
    // Footer reads 100% at the end.
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
    // Scrolling down on a buffer smaller than the body should not advance.
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

  // Under the Kitty keyboard protocol (e.g. VSCode integrated terminal),
  // ordinary printable keys arrive as CSI-u sequences.
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
    viewer.handleInput('\u001B[71u'); // G (uppercase)
    const rendered = strip(viewer.render(120).join('\n'));
    expect(rendered).toContain('line-199');
  });
});

describe('TaskOutputViewer — live tail via setProps', () => {
  function makeOutput(n: number): string {
    return Array.from({ length: n }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`).join('\n');
  }

  it('follows new lines when the viewer is already parked at the bottom', () => {
    // 5 lines, body has ~26 viewable rows → user is at bottom by default.
    const viewer = makeViewer({ output: makeOutput(5), rows: 30 });
    viewer.handleInput('G');
    // Append more lines.
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
    // Body has 14 - 4 = 10 viewable rows; max scroll = 90. Stay at top (0).
    expect(strip(viewer.render(120).join('\n'))).toContain('line-001');
    // Output grows. Since user is at scroll=0 (not bottom), keep them at top.
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
