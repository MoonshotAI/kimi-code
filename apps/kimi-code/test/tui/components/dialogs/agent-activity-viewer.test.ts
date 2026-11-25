import { TuiAltScreen, stripTerminalSequences, visibleWidth, type Terminal } from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { AgentActivityViewer, formatSubagentActivityPreview } from '#/tui/components/dialogs/agent-activity-viewer';
import type { SubagentActivityRecord } from '#/tui/controllers/subagent-activity-store';
import { beginScreenTakeover, endScreenTakeover } from '#/tui/utils/screen-takeover';

import { VirtualTerminal } from '@moonshot-ai/pi-tui/testing';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

const CTRL_O = '\u001B[111;5u';

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

function agentTask(overrides: Record<string, unknown> = {}): BackgroundTaskInfo {
  return {
    taskId: 'agent-task-1',
    kind: 'agent',
    agentId: 'agent-1',
    description: 'find things',
    status: 'running',
    startedAt: Date.now() - 60_000,
    endedAt: null,
    ...overrides,
  } as BackgroundTaskInfo;
}

function record(overrides: Partial<SubagentActivityRecord> = {}): SubagentActivityRecord {
  return {
    agentId: 'agent-1',
    agentName: 'explore',
    description: 'find things',
    parentToolCallId: 'tc-1',
    steps: [],
    totalSteps: 0,
    status: 'running',
    version: 1,
    ...overrides,
  };
}

function makeViewer(
  props: Partial<Parameters<typeof AgentActivityViewer.prototype.setProps>[0]> & {
    record?: SubagentActivityRecord;
  } = {},
  rows = 20,
  columns = 80,
): AgentActivityViewer {
  return new AgentActivityViewer(
    {
      taskId: 'agent-task-1',
      info: agentTask(),
      record: props.record,
      onClose: vi.fn(),
      ...props,
    },
    fakeTerminal(rows, columns),
  );
}

function renderPlain(viewer: AgentActivityViewer, width = 80): string {
  return strip(viewer.render(width).join('\n'));
}

describe('AgentActivityViewer', () => {
  it('fills exactly terminal.rows lines', () => {
    const viewer = makeViewer({}, 20);
    expect(viewer.render(80).length).toBe(20);
  });

  it('shows agent label, status and step range in the header', () => {
    const viewer = makeViewer({
      record: record({
        steps: [
          { step: 8, textTail: '', toolCalls: [] },
          { step: 9, textTail: '', toolCalls: [] },
        ],
        totalSteps: 12,
      }),
    });
    const text = renderPlain(viewer, 120);
    expect(text).toContain('Agent activity');
    expect(text).toContain('explore › find things');
    expect(text).toContain('running');
    expect(text).toContain('step 8–9 / 12');
    expect(text).toContain('earlier steps discarded');
  });

  it('renders steps with tool call headers and result renderer output', () => {
    const viewer = makeViewer({
      record: record({
        steps: [
          {
            step: 0,
            textTail: 'Looking for the event bus definition.',
            toolCalls: [
              {
                id: 't1',
                name: 'Grep',
                args: { pattern: 'IEventBus', output_mode: 'content' },
                status: 'done',
                startedAt: 0,
                result: {
                  tool_call_id: 't1',
                  output: 'src/a.ts:1:IEventBus\nsrc/b.ts:2:IEventBus',
                  is_error: false,
                },
              },
            ],
          },
        ],
        totalSteps: 1,
      }),
    });
    const text = renderPlain(viewer);
    expect(text).toContain('── step 0 ──');
    expect(text).toContain('Looking for the event bus definition.');
    expect(text).toContain('Used Grep (IEventBus) · 2 matches across 2 files');
    expect(text).toContain('src/a.ts:1, src/b.ts:2');
    viewer.handleInput(CTRL_O);
    expect(renderPlain(viewer)).toContain('src/a.ts:1, src/b.ts:2');
  });

  it('hides successful output by default and reveals it with ctrl+o', () => {
    const longOutput = Array.from({ length: 10 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const makeRecord = (): SubagentActivityRecord =>
      record({
        steps: [
          {
            step: 0,
            textTail: '',
            toolCalls: [
              {
                id: 't1',
                name: 'Bash',
                args: { command: 'ls' },
                status: 'done',
                startedAt: 0,
                result: { tool_call_id: 't1', output: longOutput, is_error: false },
              },
            ],
          },
        ],
        totalSteps: 1,
      });

    const collapsed = makeViewer({ record: makeRecord() });
    const collapsedText = renderPlain(collapsed);
    expect(collapsedText).toContain('Bash');
    expect(collapsedText).toContain('line 10');
    expect(collapsedText).not.toContain('line 9');

    collapsed.handleInput(CTRL_O);
    const expandedText = renderPlain(collapsed);
    expect(expandedText).toContain('line 10');
  });

  it('opens pinned to the latest activity and keeps scroll position when the user scrolled up', () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      step: i,
      textTail: `step ${String(i)} text`,
      toolCalls: [],
    }));
    const rec = record({ steps, totalSteps: 8 });
    const viewer = makeViewer({ record: rec }, 12);

    expect(renderPlain(viewer)).toContain('step 7 text');

    viewer.handleInput('g');
    expect(renderPlain(viewer)).toContain('step 0 text');
    rec.steps.push({ step: 8, textTail: 'step 8 text', toolCalls: [] });
    rec.version += 1;
    viewer.setProps({ taskId: 'agent-task-1', info: agentTask(), record: rec, onClose: vi.fn() });
    const after = renderPlain(viewer);
    expect(after).toContain('step 0 text');
    expect(after).not.toContain('step 8 text');
  });

  it('shows an explicit empty state when no record exists', () => {
    const viewer = makeViewer({ record: undefined });
    expect(renderPlain(viewer)).toContain('[no activity recorded]');
  });

  it('renders the terminal result summary section', () => {
    const viewer = makeViewer({
      info: agentTask({ status: 'completed' }),
      record: record({ status: 'completed', resultSummary: 'Found 3 call sites.' }),
    });
    const text = renderPlain(viewer);
    expect(text).toContain('completed');
    expect(text).toContain('Result');
    expect(text).toContain('Found 3 call sites.');
  });

  it('closes on q and escape', () => {
    const onClose = vi.fn();
    const viewer = makeViewer({ record: record(), onClose });
    viewer.handleInput('q');
    expect(onClose).toHaveBeenCalledTimes(1);
    viewer.handleInput('\u001B');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('formatSubagentActivityPreview', () => {
  it('renders steps, tool calls and the terminal result as plain text', () => {
    const text = formatSubagentActivityPreview(
      record({
        status: 'completed',
        resultSummary: 'Found 3 call sites.',
        totalSteps: 1,
        steps: [
          {
            step: 0,
            textTail: 'Looking around.',
            toolCalls: [
              {
                id: 't1',
                name: 'Grep',
                args: { pattern: 'IEventBus', output_mode: 'content' },
                status: 'done',
                startedAt: 0,
                result: {
                  tool_call_id: 't1',
                  output: 'src/a.ts:1:IEventBus\nsrc/b.ts:2:IEventBus',
                  is_error: false,
                },
              },
              {
                id: 't2',
                name: 'Read',
                args: { path: '/repo/src/a.ts' },
                status: 'running',
                startedAt: 0,
                liveOutputTail: 'reading…',
              },
            ],
          },
        ],
      }),
    );
    expect(text).toContain('── step 0 ──');
    expect(text).toContain('Looking around.');
    expect(text).toContain('✓ Used Grep (IEventBus) · 2 matches across 2 files');
    expect(text).toContain('● Using Read (/repo/src/a.ts)');
    expect(text).toContain('│ reading…');
    expect(text).toContain('Result:');
    expect(text).toContain('Found 3 call sites.');
    expect(text).not.toMatch(/\[[0-9;]*m/);
  });

  it('shows the live output tail for a running call', () => {
    const text = formatSubagentActivityPreview(
      record({
        totalSteps: 1,
        steps: [
          {
            step: 0,
            textTail: '',
            toolCalls: [
              {
                id: 't1',
                name: 'Bash',
                args: { command: 'pnpm test' },
                status: 'running',
                startedAt: 0,
                liveOutputTail: '42 passing',
              },
            ],
          },
        ],
      }),
    );
    expect(text).toContain('● Using Bash (pnpm test)');
    expect(text).toContain('│ 42 passing');
  });

  it('returns a waiting placeholder for a fresh running record', () => {
    expect(formatSubagentActivityPreview(record())).toBe('Waiting for activity…');
  });

  it('returns an empty string for a terminal record without any activity', () => {
    expect(formatSubagentActivityPreview(record({ status: 'failed' }))).toBe('');
  });
});

describe('AgentActivityViewer — fullscreen mouse and scrollbar', () => {
  it('omits scrollbar glyphs in direct regular-mode render', () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({
      step: i,
      textTail: `step ${String(i)} output`,
      toolCalls: [],
    }));
    const viewer = makeViewer({ record: record({ steps, totalSteps: 12 }) }, 12, 80);
    const rawRows = viewer.render(80);
    expect(rawRows).toHaveLength(12);
    for (const rawRow of rawRows.slice(2, -2)) {
      expect(visibleWidth(rawRow)).toBe(80);
      const row = stripTerminalSequences(rawRow);
      expect(row.startsWith('│ ')).toBe(true);
      expect(row.endsWith(' │')).toBe(true);
      expect(row[78]).toBe(' ');
      expect(row).not.toMatch(/[┃█]/);
    }
  });

  it('supports mouse wheel scrolling, clickable Ctrl+O expand toggle, and clickable close in TuiAltScreen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);

    const onClose = vi.fn();
    const width = 90;
    const height = 14;
    const vt = new VirtualTerminal(width, height);
    const ui = new TuiAltScreen(vt);
    const longOutput = Array.from({ length: 10 }, (_, i) => `tool-line-${String(i + 1)}`).join('\n');
    const rec = record({
      steps: [
        ...Array.from({ length: 8 }, (_, i) => ({
          step: i,
          textTail: `activity-step-${String(i)}`,
          toolCalls: [],
        })),
        {
          step: 8,
          textTail: '',
          toolCalls: [
            {
              id: 't1',
              name: 'Bash',
              args: { command: 'ls' },
              status: 'done' as const,
              startedAt: 0,
              result: { tool_call_id: 't1', output: longOutput, is_error: false },
            },
          ],
        },
      ],
      totalSteps: 9,
    });
    const viewer = new AgentActivityViewer(
      {
        taskId: 'agent-task-1',
        info: agentTask(),
        record: rec,
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
    const bodyRows = initial.slice(2, height - 2);
    for (const row of bodyRows) {
      expect(row[0]).toBe('│');
      expect(row[width - 1]).toBe('│');
    }
    expect(bodyRows.some((row) => row[width - 2] === '┃' || row[width - 2] === '│')).toBe(true);
    expect(initial[height - 1]).toContain('Ctrl+O expand');

    vi.setSystemTime(10_400);
    const expandCol = initial[height - 1]!.indexOf('Ctrl+O');
    expect(expandCol).toBeGreaterThan(0);
    vt.sendInput(`\u001B[<0;${String(expandCol + 1)};${String(height)}M`);
    vt.sendInput(`\u001B[<0;${String(expandCol + 1)};${String(height)}m`);
    await vt.waitForRender();

    const expanded = readRows();
    expect(expanded[height - 1]).toContain('Ctrl+O collapse');
    expect(expanded.join('\n')).toContain('tool-line-10');
    expect(ui.getFocusedComponent()).toBe(viewer);
    expect(viewer.focused).toBe(true);

    for (let i = 0; i < 40; i++) {
      vt.sendInput('\u001B[<64;20;5M');
    }
    await vt.waitForRender();
    const scrolledUp = readRows();
    expect(scrolledUp.join('\n')).toContain('activity-step-0');

    const closeCol = scrolledUp[height - 1]!.indexOf('Q/Esc');
    expect(closeCol).toBeGreaterThan(0);
    vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(height)}M`);
    vt.sendInput(`\u001B[<0;${String(closeCol + 1)};${String(height)}m`);
    await vt.waitForRender();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ui.getFocusedComponent()).toBe(viewer);
  });
});
