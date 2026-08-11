import type { Terminal } from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { AgentActivityViewer, formatSubagentActivityPreview } from '#/tui/components/dialogs/agent-activity-viewer';
import type { SubagentActivityRecord } from '#/tui/controllers/subagent-activity-store';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

/** Kitty CSI-u form of Ctrl+O (codepoint 111, modifier 1+4). */
const CTRL_O = '\u001B[111;5u';

/** Minimal Terminal stub — only `rows` is read by the component. */
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
                args: { pattern: 'IEventBus' },
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
    expect(text).toContain('Used Grep (IEventBus) · 2 matches');
    // grep glance renderer: path samples below the header (`path:line` form)
    expect(text).toContain('src/a.ts:1, src/b.ts:2');
  });

  it('collapses long output by default and expands it with ctrl+o', () => {
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
    expect(collapsedText).toContain('ctrl+o to expand');
    expect(collapsedText).not.toContain('line 10');

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

    // Initial render follows the tail: the last step is visible.
    expect(renderPlain(viewer)).toContain('step 7 text');

    // User scrolls to the top, then new activity arrives (version bump):
    // the view must stay where the user parked it.
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
                args: { pattern: 'IEventBus' },
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
    expect(text).toContain('✓ Used Grep (IEventBus) · 2 matches');
    expect(text).toContain('● Using Read (/repo/src/a.ts)');
    expect(text).toContain('│ reading…'); // live tail for the in-flight call
    expect(text).toContain('Result:');
    expect(text).toContain('Found 3 call sites.');
    // The preview frame styles whole lines itself — the preview stays ANSI-free.
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
