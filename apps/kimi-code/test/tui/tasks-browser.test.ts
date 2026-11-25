import {
  TuiAltScreen,
  stripTerminalSequences,
  visibleWidth,
  type Terminal,
} from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo, BackgroundTaskStatus, Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  TasksBrowserApp,
  type TasksBrowserProps,
  type TasksFilter,
} from '@/tui/components/dialogs/tasks-browser';
import { AgentActivityViewer } from '@/tui/components/dialogs/agent-activity-viewer';
import { TaskOutputViewer } from '@/tui/components/dialogs/task-output-viewer';
import { SubagentActivityStore } from '@/tui/controllers/subagent-activity-store';
import { TasksBrowserController, type TasksBrowserState } from '@/tui/controllers/tasks-browser';
import { darkColors } from '@/tui/theme/colors';
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

function task(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    taskId: 'bash-abcd1234',
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

function makeProps(overrides: Partial<TasksBrowserProps> = {}): TasksBrowserProps {
  return {
    tasks: [],
    filter: 'all',
    selectedTaskId: undefined,
    tailOutput: undefined,
    tailLoading: false,
    flashMessage: undefined,
    availableModels: {},
    onSelect: vi.fn(),
    onToggleFilter: vi.fn(),
    onRefresh: vi.fn(),
    onCancel: vi.fn(),
    onStopConfirmed: vi.fn(),
    onOpenOutput: vi.fn(),
    onStopIgnored: vi.fn(),
    ...overrides,
  } as TasksBrowserProps;
}

const CATALOG = {
  'k2-cheap': {
    provider: 'managed:kimi-code',
    model: 'kimi-k2-cheap',
    displayName: 'Kimi K2 Cheap',
  },
} as never;

function makeApp(
  props: Partial<TasksBrowserProps> = {},
  rows = 30,
  columns = 120,
): TasksBrowserApp {
  return new TasksBrowserApp(makeProps(props), fakeTerminal(rows, columns));
}

describe('TasksBrowserApp — full-screen rendering', () => {
  it('fills exactly terminal.rows lines (height takeover)', () => {
    const rows = 30;
    const lines = makeApp({}, rows).render(120);
    expect(lines.length).toBe(rows);
  });

  it('reacts to terminal height changes', () => {
    const props = makeProps({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
    });
    const small = new TasksBrowserApp(props, fakeTerminal(15, 120)).render(120);
    const big = new TasksBrowserApp(props, fakeTerminal(40, 120)).render(120);
    expect(small.length).toBe(15);
    expect(big.length).toBe(40);
  });

  it('clamps the detail frame to the body at the minimum terminal height', () => {
    const props = makeProps({
      tasks: [
        task({
          taskId: 'agent-aaaaaaaa',
          kind: 'agent',
          status: 'running',
          agentId: 'agent-1',
          subagentType: 'explore',
          model: 'kimi-code/k3-256k',
          thinkingEffort: 'low',
        }),
      ],
      selectedTaskId: 'agent-aaaaaaaa',
    });
    const lines = new TasksBrowserApp(props, fakeTerminal(10, 120)).render(120);
    expect(lines.length).toBe(10);
    expect(strip(lines.join('\n'))).toContain('Preview Output');
  });

  it('shows the header row with TASK BROWSER title and counts', () => {
    const props: Partial<TasksBrowserProps> = {
      tasks: [
        task({ taskId: 'bash-aaaaaaaa', status: 'running' }),
        task({ taskId: 'agent-bbbbbbbb', status: 'completed' }),
      ],
    };
    const out = strip(makeApp(props).render(120).join('\n'));
    expect(out).toContain('TASK BROWSER');
    expect(out).toContain('filter=ALL');
    expect(out).toContain('1 running');
    expect(out).toContain('1 completed');
    expect(out).toContain('2 total');
  });

  it('renders three framed panes: Tasks / Detail / Preview Output', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
        selectedTaskId: 'bash-aaaaaaaa',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('Tasks [all]');
    expect(out).toContain('Detail');
    expect(out).toContain('Preview Output');
  });

  it('shows the selected task details in the Detail pane', () => {
    const out = strip(
      makeApp({
        tasks: [
          task({
            taskId: 'bash-aaaaaaaa',
            status: 'running',
            description: 'long running task',
            pid: 9999,
          }),
        ],
        selectedTaskId: 'bash-aaaaaaaa',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('Task ID:');
    expect(out).toContain('bash-aaaaaaaa');
    expect(out).toContain('long running task');
  });

  it('shows question task details in the Detail pane', () => {
    const out = strip(
      makeApp({
        tasks: [
          task({
            taskId: 'question-aaaaaaaa',
            kind: 'question',
            description: 'Which database?',
            questionCount: 1,
            toolCallId: 'call_question',
          }),
        ],
        selectedTaskId: 'question-aaaaaaaa',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('question-aaaaaaaa');
    expect(out).toContain('Questions:');
    expect(out).toContain('1');
    expect(out).toContain('Tool call:');
    expect(out).toContain('call_question');
  });

  it('shows the bound model and effort for agent tasks in the Detail pane', () => {
    const out = strip(
      makeApp({
        tasks: [
          task({
            taskId: 'agent-aaaaaaaa',
            kind: 'agent',
            description: 'explore project',
            agentId: 'agent-1',
            subagentType: 'explore',
            model: 'kimi-code/k3-256k',
            thinkingEffort: 'low',
          }),
        ],
        selectedTaskId: 'agent-aaaaaaaa',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('Agent type:');
    expect(out).toContain('explore');
    expect(out).toContain('Model:');
    expect(out).toContain('kimi-code/k3-256k');
    expect(out).toContain('Effort:');
    expect(out).toContain('low');
  });

  it('shows the agent model on a secondary line under the task row', () => {
    const app = makeApp({
      tasks: [
        task({
          taskId: 'agent-aaaaaaaa',
          kind: 'agent',
          status: 'running',
          description: 'explore project',
          agentId: 'agent-1',
          model: 'k2-cheap',
        }),
        task({ taskId: 'bash-bbbbbbbb', status: 'running' }),
      ],
      selectedTaskId: 'agent-aaaaaaaa',
      availableModels: CATALOG,
    });
    const lines = app.render(120).map(strip);
    const rowIndex = lines.findIndex((line) => line.includes('agent-aaaaaaaa'));
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(lines[rowIndex + 1]).toContain('Kimi K2 Cheap');
    expect(lines[rowIndex + 2]).toContain('bash-bbbbbbbb');
  });

  it('falls back to the raw model alias when the catalog has no entry', () => {
    const app = makeApp({
      tasks: [
        task({
          taskId: 'agent-aaaaaaaa',
          kind: 'agent',
          status: 'running',
          agentId: 'agent-1',
          model: 'kimi-code/k3-256k',
        }),
      ],
      selectedTaskId: 'agent-aaaaaaaa',
    });
    const lines = app.render(120).map(strip);
    const rowIndex = lines.findIndex((line) => line.includes('agent-aaaaaaaa'));
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(lines[rowIndex + 1]).toContain('kimi-code/k3-256k');
  });

  it('resolves the Detail pane model through the catalog', () => {
    const out = strip(
      makeApp({
        tasks: [
          task({
            taskId: 'agent-aaaaaaaa',
            kind: 'agent',
            status: 'running',
            agentId: 'agent-1',
            model: 'k2-cheap',
          }),
        ],
        selectedTaskId: 'agent-aaaaaaaa',
        availableModels: CATALOG,
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('Model:');
    expect(out).toContain('Kimi K2 Cheap');
  });

  it('keeps agent tasks without a model on a single line', () => {
    const app = makeApp({
      tasks: [
        task({
          taskId: 'agent-aaaaaaaa',
          kind: 'agent',
          status: 'running',
          agentId: 'agent-1',
          startedAt: 1,
        }),
        task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
      ],
      selectedTaskId: 'agent-aaaaaaaa',
    });
    const lines = app.render(120).map(strip);
    const rowIndex = lines.findIndex((line) => line.includes('agent-aaaaaaaa'));
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(lines[rowIndex + 1]).toContain('bash-bbbbbbbb');
  });

  it('keeps the selected agent row and its model line visible when scrolling', () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({
        taskId: `agent-${String(i).padStart(8, '0')}`,
        kind: 'agent',
        status: 'running',
        description: `task ${String(i)}`,
        agentId: `agent-${String(i)}`,
        model: 'k2-cheap',
        startedAt: i,
      } as Partial<BackgroundTaskInfo>),
    );
    const app = new TasksBrowserApp(
      makeProps({ tasks, selectedTaskId: 'agent-00000011', availableModels: CATALOG }),
      fakeTerminal(12, 120),
    );
    const lines = app.render(120).map(strip);
    expect(lines.length).toBe(12);
    const rowIndex = lines.findIndex((line) => line.includes('agent-00000011'));
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(lines[rowIndex + 1]).toContain('Kimi K2 Cheap');
  });

  it('renders tail output in the Preview Output pane', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa' })],
        selectedTaskId: 'bash-aaaaaaaa',
        tailOutput: 'ready in 432ms\nlistening on :3000',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('ready in 432ms');
    expect(out).toContain('listening on :3000');
  });

  it('does not pass terminal controls from tail output into the framed preview', () => {
    const rendered = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      tailOutput: 'Downloading wheel 25%\rDownloading wheel 75%\u001B[2Jdone',
    }).render(120);
    const raw = rendered.join('\n');

    expect(raw).not.toContain('\r');
    expect(raw).not.toContain('\u001B[2J');
    expect(strip(raw)).toContain('Downloading wheel 25%Downloading wheel 75%done');
  });

  it('shows a loading state when tail is loading', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa' })],
        selectedTaskId: 'bash-aaaaaaaa',
        tailLoading: true,
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('[loading');
  });

  it('shows empty-state copy in the Tasks pane when no tasks', () => {
    const out = strip(makeApp().render(120).join('\n'));
    expect(out).toContain('No tasks');
  });

  it('filters out terminal tasks when filter=active', () => {
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running' }),
      task({ taskId: 'bash-bbbbbbbb', status: 'completed' }),
    ];
    const out = strip(makeApp({ tasks, filter: 'active' }).render(120).join('\n'));
    expect(out).toContain('bash-aaaaaaaa');
    expect(out).not.toContain('bash-bbbbbbbb');
  });

  it('shows running foreground agents alongside background tasks', () => {
    const tasks = [
      task({ taskId: 'agent-foreground', kind: 'agent', detached: false, status: 'running' }),
      task({ taskId: 'agent-finished', kind: 'agent', detached: false, status: 'completed' }),
      task({ taskId: 'bash-foreground', detached: false, status: 'running' }),
      task({ taskId: 'bash-background', detached: true, status: 'running' }),
    ];
    const out = strip(makeApp({ tasks, selectedTaskId: 'agent-foreground' }).render(120).join('\n'));
    expect(out).toContain('agent-foreground');
    expect(out).toContain('Foreground');
    expect(out).not.toContain('agent-finished');
    expect(out).not.toContain('bash-foreground');
    expect(out).toContain('bash-background');
  });

  it('keeps background tasks with detached === true even when terminal', () => {
    const tasks = [task({ taskId: 'bash-done', detached: true, status: 'completed' })];
    const out = strip(makeApp({ tasks, filter: 'all' }).render(120).join('\n'));
    expect(out).toContain('bash-done');
  });

  it('keeps ghost tasks whose detached field is undefined', () => {
    const tasks = [task({ taskId: 'bash-ghost', status: 'lost' })];
    const out = strip(makeApp({ tasks, filter: 'all' }).render(120).join('\n'));
    expect(out).toContain('bash-ghost');
  });

  it('applies active filter after excluding foreground tasks', () => {
    const tasks = [
      task({ taskId: 'bash-fg-running', detached: false, status: 'running' }),
      task({ taskId: 'bash-bg-running', detached: true, status: 'running' }),
      task({ taskId: 'bash-bg-done', detached: true, status: 'completed' }),
    ];
    const out = strip(makeApp({ tasks, filter: 'active' }).render(120).join('\n'));
    expect(out).not.toContain('bash-fg-running');
    expect(out).toContain('bash-bg-running');
    expect(out).not.toContain('bash-bg-done');
  });

  it('renders without throwing for every BackgroundTaskStatus', () => {
    const statuses: BackgroundTaskStatus[] = [
      'running',
      'completed',
      'failed',
      'killed',
      'lost',
    ];
    for (const status of statuses) {
      const props = makeProps({
        tasks: [task({ taskId: 'bash-aaaaaaaa', status })],
        selectedTaskId: 'bash-aaaaaaaa',
      });
      expect(() => new TasksBrowserApp(props, fakeTerminal(30)).render(120)).not.toThrow();
    }
  });

  it('falls back to a single line when the terminal is too small', () => {
    const out = strip(makeApp({}, 5, 30).render(30).join('\n'));
    expect(out).toContain('too small');
  });
});

describe('TasksBrowserApp — input handling', () => {
  it('Esc invokes onCancel', () => {
    const onCancel = vi.fn();
    const app = makeApp({ onCancel });
    app.handleInput('');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('q invokes onCancel', () => {
    const onCancel = vi.fn();
    makeApp({ onCancel }).handleInput('q');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+T is not a tasks-browser shortcut', () => {
    const onCancel = vi.fn();
    makeApp({ onCancel }).handleInput('\u0014');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Tab invokes onToggleFilter', () => {
    const onToggleFilter = vi.fn();
    makeApp({ onToggleFilter }).handleInput('\t');
    expect(onToggleFilter).toHaveBeenCalledTimes(1);
  });

  it('R invokes onRefresh', () => {
    const onRefresh = vi.fn();
    makeApp({ onRefresh }).handleInput('r');
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('arrow keys move selection and invoke onSelect', () => {
    const onSelect = vi.fn();
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
      task({ taskId: 'bash-cccccccc', status: 'running', startedAt: 3 }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-aaaaaaaa', onSelect });
    app.handleInput('[B');
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
    app.handleInput('j');
    expect(onSelect).toHaveBeenLastCalledWith('bash-cccccccc');
    app.handleInput('[A');
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
  });

  it('Enter and O both invoke onOpenOutput', () => {
    const onOpenOutput = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onOpenOutput,
    });
    app.handleInput('o');
    app.handleInput('\r');
    expect(onOpenOutput).toHaveBeenCalledTimes(2);
    expect(onOpenOutput).toHaveBeenCalledWith('bash-aaaaaaaa');
  });
});

describe('TasksBrowserApp — Kitty CSI-u printable input', () => {
  const kitty = (ch: string): string => `\u001B[${String(ch.codePointAt(0) ?? 0)}u`;

  it('Kitty-encoded q invokes onCancel', () => {
    const onCancel = vi.fn();
    makeApp({ onCancel }).handleInput(kitty('q'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Kitty-encoded r invokes onRefresh', () => {
    const onRefresh = vi.fn();
    makeApp({ onRefresh }).handleInput(kitty('r'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('Kitty-encoded j moves selection down', () => {
    const onSelect = vi.fn();
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-aaaaaaaa', onSelect });
    app.handleInput(kitty('j'));
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
  });

  it('Kitty-encoded o invokes onOpenOutput', () => {
    const onOpenOutput = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onOpenOutput,
    });
    app.handleInput(kitty('o'));
    expect(onOpenOutput).toHaveBeenCalledWith('bash-aaaaaaaa');
  });

  it('Kitty-encoded s → y confirms a stop', () => {
    const onStopConfirmed = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
    });
    app.handleInput(kitty('s'));
    app.handleInput(kitty('y'));
    expect(onStopConfirmed).toHaveBeenCalledWith('bash-aaaaaaaa');
  });
});

describe('TasksBrowserApp — stop confirmation', () => {
  it('S → y confirms a stop and invokes onStopConfirmed', () => {
    const onStopConfirmed = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
    });
    app.handleInput('s');
    const after = strip(app.render(120).join('\n'));
    expect(after).toContain('Stop bash-aaaaaaaa?');
    app.handleInput('y');
    expect(onStopConfirmed).toHaveBeenCalledWith('bash-aaaaaaaa');
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });

  it('S → n cancels without firing onStopConfirmed', () => {
    const onStopConfirmed = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
    });
    app.handleInput('s');
    app.handleInput('n');
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });

  it('S → Esc cancels the confirm without closing the panel', () => {
    const onStopConfirmed = vi.fn();
    const onCancel = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'running' })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
      onCancel,
    });
    app.handleInput('s');
    app.handleInput('');
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('S on a terminal task invokes onStopIgnored and stays out of confirm mode', () => {
    const onStopConfirmed = vi.fn();
    const onStopIgnored = vi.fn();
    const app = makeApp({
      tasks: [task({ taskId: 'bash-aaaaaaaa', status: 'completed', exitCode: 0 })],
      selectedTaskId: 'bash-aaaaaaaa',
      onStopConfirmed,
      onStopIgnored,
    });
    app.handleInput('s');
    expect(onStopIgnored).toHaveBeenCalledWith('bash-aaaaaaaa', 'terminal');
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });

  it('navigation during confirm mode is locked out', () => {
    const onSelect = vi.fn();
    const onStopConfirmed = vi.fn();
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running', startedAt: 2 }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-aaaaaaaa', onSelect, onStopConfirmed });
    app.handleInput('s');
    onSelect.mockClear();
    app.handleInput('[B');
    expect(onSelect).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).not.toContain('Stop bash-aaaaaaaa?');
  });
});

describe('TasksBrowserApp — setProps', () => {
  it('keeps selection across prop updates when the task still exists', () => {
    const tasks = [
      task({ taskId: 'bash-aaaaaaaa', status: 'running' }),
      task({ taskId: 'bash-bbbbbbbb', status: 'running' }),
    ];
    const app = makeApp({ tasks, selectedTaskId: 'bash-bbbbbbbb' });
    app.setProps({
      ...makeProps({
        tasks: [...tasks, task({ taskId: 'bash-cccccccc', status: 'completed' })],
        selectedTaskId: 'bash-bbbbbbbb',
      }),
    });
    const out = strip(app.render(120).join('\n'));
    expect(out).toContain('bash-bbbbbbbb');
  });

  it('switches the filter via setProps without throwing', () => {
    const tasks = [task({ status: 'completed' })];
    const filters: TasksFilter[] = ['all', 'active', 'all'];
    const app = makeApp({ tasks });
    for (const filter of filters) {
      expect(() => {
        app.setProps(makeProps({ tasks, filter }));
      }).not.toThrow();
    }
  });
});

describe('TasksBrowserController — opening an agent task', () => {
  function makeControllerHost(tasks: BackgroundTaskInfo[], store: SubagentActivityStore) {
    const ui = {
      children: [] as unknown[],
      clear() {
        this.children = [];
      },
      addChild(child: unknown) {
        this.children.push(child);
      },
      setFocus: () => {},
      requestRender: () => {},
    };
    const state = {
      tasksBrowser: undefined as TasksBrowserState | undefined,
      terminal: fakeTerminal(30),
      ui,
      editor: {},
      appState: { availableModels: {} },
    };
    const host = {
      state,
      sessionEventHandler: { subAgentEventHandler: { activityStore: store } },
      session: {
        listBackgroundTasks: async () => tasks,
        getBackgroundTaskOutput: async () => 'captured output',
      },
      showError: vi.fn(),
      setTasksBrowser(value: TasksBrowserState | undefined) {
        state.tasksBrowser = value;
      },
    };
    return { host, state };
  }

  function agentTaskInfo(store: SubagentActivityStore | null): BackgroundTaskInfo {
    const info = task({
      taskId: 'agent-task-1',
      kind: 'agent',
      agentId: 'agent-1',
      parentToolCallId: 'tc-1',
      status: 'running',
    } as Partial<BackgroundTaskInfo>);
    if (store !== null) {
      store.ensureRecord({ agentId: 'agent-1', agentName: 'explore', parentToolCallId: 'tc-1' });
    }
    return info;
  }

  async function openSelectedViewer(controller: TasksBrowserController, taskId: string) {
    await (
      controller as unknown as { handleOpenOutput(taskId: string): Promise<void> }
    ).handleOpenOutput(taskId);
  }

  it('opens the activity viewer when a record exists for the agent', async () => {
    const store = new SubagentActivityStore();
    const { host, state } = makeControllerHost([agentTaskInfo(store)], store);
    const controller = new TasksBrowserController(host as never);
    await controller.show();

    await openSelectedViewer(controller, 'agent-task-1');

    const viewer = (state.tasksBrowser as { viewer: { component: unknown } }).viewer;
    expect(viewer.component).toBeInstanceOf(AgentActivityViewer);
    controller.close();
  });

  it('falls back to the output viewer when no record exists', async () => {
    const store = new SubagentActivityStore();
    const { host, state } = makeControllerHost([agentTaskInfo(null)], store);
    const controller = new TasksBrowserController(host as never);
    await controller.show();

    await openSelectedViewer(controller, 'agent-task-1');

    const viewer = (state.tasksBrowser as { viewer: { component: unknown } }).viewer;
    expect(viewer.component).toBeInstanceOf(TaskOutputViewer);
    controller.close();
  });

  it('shows the captured output of a background task after the same agent is called again', async () => {
    const store = new SubagentActivityStore();
    const taskInfo = { ...agentTaskInfo(store), detached: true, status: 'completed' as const };
    store.markCompleted('agent-1', 'Previous result');
    store.ensureRecord({ agentId: 'agent-1', agentName: 'explore', parentToolCallId: 'tc-2' });
    const { host, state } = makeControllerHost([taskInfo], store);
    const controller = new TasksBrowserController(host as never);
    try {
      await controller.show();
      state.tasksBrowser?.component.handleInput('\r');
      await vi.waitFor(() => {
        const viewer = state.tasksBrowser?.viewer?.component;
        expect(viewer).toBeInstanceOf(TaskOutputViewer);
        expect(strip(viewer?.render(120).join('\n') ?? '')).toContain('captured output');
      });
    } finally {
      controller.close();
    }
  });

  it('opens a foreground agent, follows its activity, and keeps the result until closing', async () => {
    vi.useFakeTimers();
    const store = new SubagentActivityStore();
    const tasks = [
      { ...agentTaskInfo(null), detached: false },
      task({ taskId: 'bash-background', detached: true, startedAt: Date.now() }),
    ];
    const { host, state } = makeControllerHost(tasks, store);
    const controller = new TasksBrowserController(host as never);
    try {
      await controller.show();
      const browser = state.tasksBrowser!.component;
      browser.handleInput('s');
      expect(strip(browser.render(120).join('\n'))).not.toContain('Stop agent-task-1?');
      browser.handleInput('\t');
      browser.handleInput('\r');

      const viewer = state.tasksBrowser!.viewer?.component;
      expect(viewer).toBeInstanceOf(AgentActivityViewer);
      expect(strip(viewer!.render(120).join('\n'))).toContain('Waiting for activity');

      store.ensureRecord({ agentId: 'agent-1', agentName: 'explore', parentToolCallId: 'tc-1' });
      store.applyEvent({
        sessionId: 's1',
        agentId: 'agent-1',
        type: 'thinking.delta',
        turnId: 1,
        delta: 'Inspect the public entry point.',
      } as Event);
      store.applyEvent({
        sessionId: 's1',
        agentId: 'agent-1',
        type: 'assistant.delta',
        turnId: 1,
        delta: 'Found the main entry point.',
      } as Event);
      await vi.advanceTimersByTimeAsync(1000);

      const active = strip(viewer!.render(120).join('\n'));
      expect(active).toContain('Thinking');
      expect(active).toContain('Inspect the public entry point.');
      expect(active).toContain('Found the main entry point.');

      tasks.shift();
      const record = store.get('agent-1')!;
      store.markCompleted('agent-1', 'Agent result');
      store.drop('agent-1');
      controller.onSubagentSettled(record);

      const completed = strip(viewer!.render(120).join('\n'));
      expect(completed).toContain('completed');
      expect(completed).toContain('Agent result');
      viewer!.handleInput('\u001B');
      await Promise.resolve();
      const list = strip(browser.render(120).join('\n'));
      expect(list).not.toContain('agent-task-1');
      expect(list).toContain('bash-background');
      expect(list).toContain('captured output');
    } finally {
      controller.close();
      vi.useRealTimers();
    }
  });

  it('feeds the preview pane from the activity store for agent tasks', async () => {
    const store = new SubagentActivityStore();
    store.ensureRecord({ agentId: 'agent-1', agentName: 'explore', parentToolCallId: 'tc-1' });
    store.applyEvent({
      sessionId: 's1',
      agentId: 'agent-1',
      type: 'turn.step.started',
      turnId: 1,
      step: 0,
    } as Event);
    store.applyEvent({
      sessionId: 's1',
      agentId: 'agent-1',
      type: 'tool.call.started',
      turnId: 1,
      toolCallId: 't1',
      name: 'Grep',
      args: { pattern: 'foo', output_mode: 'content' },
    } as Event);
    store.applyEvent({
      sessionId: 's1',
      agentId: 'agent-1',
      type: 'tool.result',
      turnId: 1,
      toolCallId: 't1',
      output: 'src/a.ts:1:foo\nsrc/b.ts:2:foo',
      isError: false,
    } as Event);

    const { host, state } = makeControllerHost([agentTaskInfo(null)], store);
    const controller = new TasksBrowserController(host as never);
    await controller.show();

    const browser = state.tasksBrowser as { tailOutput?: string };
    expect(browser.tailOutput).toContain('── step 0 ──');
    expect(browser.tailOutput).toContain('✓ Used Grep (foo) · 2 matches across 2 files');
    controller.close();
  });
});

describe('TasksBrowserApp — fullscreen mouse, panes, and layout parity', () => {
  function click(vt: VirtualTerminal, col1: number, row1: number): void {
    vt.sendInput(`\u001B[<0;${String(col1)};${String(row1)}M`);
    vt.sendInput(`\u001B[<0;${String(col1)};${String(row1)}m`);
  }

  function makeRichTasks(count: number): BackgroundTaskInfo[] {
    return Array.from({ length: count }, (_, i) =>
      task({
        taskId: `bash-${String(i + 1).padStart(8, '0')}`,
        status: 'running',
        description: `worker process ${String(i + 1)}`,
        command: `node worker-${String(i + 1)}.js`,
        pid: 2000 + i,
        exitCode: 0,
        stopReason: `reason-${String(i + 1)}`,
        startedAt: i + 1,
      }),
    );
  }

  function makeBigTail(count: number): string {
    return Array.from({ length: count }, (_, i) => `tail-line-${String(i + 1).padStart(3, '0')}`).join(
      '\n',
    );
  }

  function measureLeftPaneWidth(renderedRow: string): number {
    const plain = stripTerminalSequences(renderedRow);
    const leftEnd = plain.indexOf('╮');
    expect(leftEnd).toBeGreaterThan(0);
    return leftEnd + 1;
  }

  it('matches original clamp(floor(w * 0.32), 28, 44) column widths across widths 48, 80, 100, 120, 160', () => {
    const tasks = [task({ taskId: 'bash-aaaaaaaa', status: 'running' })];
    const cases: readonly [number, number][] = [
      [48, 28],
      [80, 28],
      [100, 32],
      [120, 38],
      [160, 44],
    ];
    for (const [width, expectedLeft] of cases) {
      const app = new TasksBrowserApp(
        makeProps({ tasks, selectedTaskId: 'bash-aaaaaaaa', tailOutput: 'hello' }),
        fakeTerminal(20, width),
      );
      const lines = app.render(width);
      expect(lines).toHaveLength(20);
      expect(visibleWidth(lines[1]!)).toBe(width);
      const leftWidth = measureLeftPaneWidth(lines[1]!);
      expect(leftWidth).toBe(expectedLeft);
      const plainTop = stripTerminalSequences(lines[1]!);
      expect(plainTop[expectedLeft]).toBe('╭');
      expect(plainTop[width - 1]).toBe('╮');
    }

    const terminal = fakeTerminal(20, 120);
    const resizable = new TasksBrowserApp(
      makeProps({ tasks, selectedTaskId: 'bash-aaaaaaaa', tailOutput: 'hello' }),
      terminal,
    );
    expect(measureLeftPaneWidth(resizable.render(120)[1]!)).toBe(38);
    expect(stripTerminalSequences(resizable.render(40).join('\n'))).toContain('Terminal too small');
    expect(measureLeftPaneWidth(resizable.render(80)[1]!)).toBe(28);
  });

  it('omits scrollbar glyphs and schedules zero timers in regular-mode direct render', () => {
    vi.useFakeTimers();
    try {
      const tasks = makeRichTasks(25);
      const app = new TasksBrowserApp(
        makeProps({
          tasks,
          selectedTaskId: 'bash-00000001',
          tailOutput: makeBigTail(80),
        }),
        fakeTerminal(16, 100),
      );
      const rows = app.render(100);
      expect(rows).toHaveLength(16);
      for (const rawRow of rows) {
        expect(visibleWidth(rawRow)).toBe(100);
        expect(stripTerminalSequences(rawRow)).not.toMatch(/[┃█]/);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains wheel scrolling independently per pane without leaking to Preview Output', async () => {
    const width = 100;
    const height = 14;
    const vt = new VirtualTerminal(width, height);
    const ui = new TuiAltScreen(vt);
    const tasks = makeRichTasks(20);
    const app = new TasksBrowserApp(
      makeProps({
        tasks,
        selectedTaskId: 'bash-00000001',
        tailOutput: makeBigTail(60),
      }),
      vt,
    );
    const takeover = beginScreenTakeover(ui, app);
    ui.setFocus(app);
    ui.start();
    onTestFinished(() => {
      endScreenTakeover(ui, takeover);
      ui.stop();
    });
    await vt.waitForRender();

    const readRows = (): string[] => vt.getViewport().map(strip);
    const initial = readRows();
    const leftWidth = measureLeftPaneWidth(initial[1]!);
    expect(leftWidth).toBe(32);
    expect(initial.join('\n')).toContain('bash-00000001');
    expect(initial.join('\n')).not.toContain('bash-00000020');
    expect(initial.join('\n')).toContain('tail-line-060');
    expect(initial.join('\n')).not.toContain('tail-line-001');

    const detailTopRow = initial.findIndex((row) => row.includes('Detail'));
    const previewTopRow = initial.findIndex((row) => row.includes('Preview Output'));
    expect(detailTopRow).toBe(1);
    expect(previewTopRow).toBeGreaterThan(detailTopRow + 1);

    for (let i = 0; i < 20; i++) {
      vt.sendInput('\u001B[<65;5;4M');
    }
    await vt.waitForRender();
    const afterListWheel = readRows();
    expect(afterListWheel.join('\n')).toContain('bash-00000020');
    expect(afterListWheel.join('\n')).toContain('tail-line-060');
    expect(afterListWheel.join('\n')).not.toContain('tail-line-001');

    for (let i = 0; i < 10; i++) {
      vt.sendInput(`\u001B[<64;5;4M`);
    }
    await vt.waitForRender();
    expect(readRows().join('\n')).toContain('tail-line-060');

    const rightCol1 = leftWidth + 4;
    const detailBodyRow1 = detailTopRow + 2;
    for (let i = 0; i < 10; i++) {
      vt.sendInput(`\u001B[<65;${String(rightCol1)};${String(detailBodyRow1)}M`);
    }
    await vt.waitForRender();
    const afterDetailWheel = readRows();
    expect(afterDetailWheel.join('\n')).toContain('reason-1');
    expect(afterDetailWheel.join('\n')).toContain('tail-line-060');

    for (let i = 0; i < 10; i++) {
      vt.sendInput(`\u001B[<64;${String(rightCol1)};${String(detailBodyRow1)}M`);
    }
    await vt.waitForRender();
    const afterDetailWheelUp = readRows();
    expect(afterDetailWheelUp.join('\n')).toContain('Task ID:');
    expect(afterDetailWheelUp.join('\n')).toContain('tail-line-060');

    const previewBodyRow1 = previewTopRow + 2;
    for (let i = 0; i < 30; i++) {
      vt.sendInput(`\u001B[<64;${String(rightCol1)};${String(previewBodyRow1)}M`);
    }
    await vt.waitForRender();
    const afterPreviewWheel = readRows();
    expect(afterPreviewWheel.join('\n')).not.toContain('tail-line-060');
    expect(afterPreviewWheel.join('\n')).toContain('tail-line-030');

    app.setProps(
      makeProps({
        tasks,
        selectedTaskId: 'bash-00000001',
        tailOutput: makeBigTail(65),
      }),
    );
    ui.requestRender();
    await vt.waitForRender();
    expect(readRows().join('\n')).not.toContain('tail-line-065');

    app.setProps(
      makeProps({
        tasks,
        selectedTaskId: 'bash-00000002',
        tailOutput: makeBigTail(65),
      }),
    );
    ui.requestRender();
    await vt.waitForRender();
    const afterTaskChange = readRows();
    expect(afterTaskChange.join('\n')).toContain('tail-line-065');
    expect(afterTaskChange.join('\n')).toContain('Task ID:');

    vt.sendInput('\u001B[5~');
    await vt.waitForRender();
    const afterPageUp = readRows();
    expect(afterPageUp.join('\n')).not.toContain('tail-line-065');
    expect(afterPageUp.join('\n')).toContain('bash-00000002');
  });

  it('never selects on pointer move, selects on click, opens output on list double-click, and preserves preview drag selection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);

    const onSelect = vi.fn();
    const onOpenOutput = vi.fn();
    const tasks = [
      task({
        taskId: 'agent-00000001',
        kind: 'agent',
        status: 'running',
        agentId: 'a1',
        model: 'k2-cheap',
        startedAt: 1,
      } as Partial<BackgroundTaskInfo>),
      task({ taskId: 'bash-00000002', status: 'running', startedAt: 2 }),
      task({ taskId: 'bash-00000003', status: 'running', startedAt: 3 }),
    ];

    const vt = new VirtualTerminal(100, 16);
    const ui = new TuiAltScreen(vt);
    const app = new TasksBrowserApp(
      makeProps({
        tasks,
        selectedTaskId: 'agent-00000001',
        tailOutput: 'line one\nline two',
        availableModels: CATALOG,
        onSelect,
        onOpenOutput,
      }),
      vt,
    );
    const takeover = beginScreenTakeover(ui, app);
    ui.setFocus(app);
    ui.start();
    onTestFinished(() => {
      endScreenTakeover(ui, takeover);
      ui.stop();
      vi.useRealTimers();
    });
    await vt.waitForRender();

    const readRows = (): string[] => vt.getViewport().map(strip);
    const rows = readRows();
    const row2 = rows.findIndex((row) => row.includes('bash-00000002'));
    const row3 = rows.findIndex((row) => row.includes('bash-00000003'));
    const modelRow = rows.findIndex((row) => row.includes('Kimi K2 Cheap'));
    const previewTopRow = rows.findIndex((row) => row.includes('Preview Output'));
    expect(row2).toBeGreaterThan(1);
    expect(row3).toBeGreaterThan(row2);
    expect(modelRow).toBeGreaterThan(1);
    expect(previewTopRow).toBeGreaterThan(1);

    vi.setSystemTime(10_400);
    vt.sendInput(`\u001B[<35;6;${String(row2 + 1)}M`);
    vt.sendInput(`\u001B[<35;6;${String(row3 + 1)}M`);
    vt.sendInput(`\u001B[<35;6;${String(modelRow + 1)}M`);
    await vt.waitForRender();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenOutput).not.toHaveBeenCalled();

    ui.setFocus(null);
    expect(app.focused).toBe(false);
    click(vt, 6, row2 + 1);
    await vt.waitForRender();
    expect(ui.getFocusedComponent()).toBe(app);
    expect(app.focused).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();

    vi.setSystemTime(11_000);
    click(vt, 6, row2 + 1);
    await vt.waitForRender();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenLastCalledWith('bash-00000002');
    expect(onOpenOutput).not.toHaveBeenCalled();

    vi.setSystemTime(11_600);
    click(vt, 6, modelRow + 1);
    await vt.waitForRender();
    expect(onSelect).toHaveBeenLastCalledWith('agent-00000001');

    vi.setSystemTime(12_200);
    click(vt, 6, row3 + 1);
    vi.setSystemTime(12_350);
    click(vt, 6, row3 + 1);
    await vt.waitForRender();
    expect(onSelect).toHaveBeenLastCalledWith('bash-00000003');
    expect(onOpenOutput).toHaveBeenCalledTimes(1);
    expect(onOpenOutput).toHaveBeenLastCalledWith('bash-00000003');

    const leftWidth = measureLeftPaneWidth(rows[1]!);
    const previewColStart = leftWidth + 2;
    const previewTextRow = previewTopRow + 2;
    vi.setSystemTime(13_000);
    vt.sendInput(`\x1b[<0;${String(previewColStart)};${String(previewTextRow)}M`);
    vt.sendInput(`\x1b[<32;${String(previewColStart + 4)};${String(previewTextRow)}M`);
    vt.sendInput(`\x1b[<0;${String(previewColStart + 4)};${String(previewTextRow)}m`);
    await vt.waitForRender();
    expect(ui.hasActiveSelection()).toBe(true);
    expect(onOpenOutput).toHaveBeenCalledTimes(1);
  });

  it('handles header filter, footer actions, and locks list clicks during stop confirm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);

    const onSelect = vi.fn();
    const onToggleFilter = vi.fn();
    const onRefresh = vi.fn();
    const onCancel = vi.fn();
    const onStopConfirmed = vi.fn();
    const onOpenOutput = vi.fn();
    const tasks = [
      task({ taskId: 'bash-00000001', status: 'running', startedAt: 1 }),
      task({ taskId: 'bash-00000002', status: 'running', startedAt: 2 }),
    ];

    const vt = new VirtualTerminal(100, 16);
    const ui = new TuiAltScreen(vt);
    const app = new TasksBrowserApp(
      makeProps({
        tasks,
        selectedTaskId: 'bash-00000001',
        onSelect,
        onToggleFilter,
        onRefresh,
        onCancel,
        onStopConfirmed,
        onOpenOutput,
      }),
      vt,
    );
    const takeover = beginScreenTakeover(ui, app);
    ui.setFocus(app);
    ui.start();
    onTestFinished(() => {
      endScreenTakeover(ui, takeover);
      ui.stop();
      vi.useRealTimers();
    });
    await vt.waitForRender();

    const readRows = (): string[] => vt.getViewport().map(strip);
    const initial = readRows();
    const headerRow1 = 1;
    const footerRow1 = 16;

    const filterHeaderCol = initial[0]!.indexOf('filter=ALL');
    const openCol = initial[15]!.indexOf('Enter/O');
    const stopCol = initial[15]!.indexOf('S stop');
    const refreshCol = initial[15]!.indexOf('R refresh');
    const filterFooterCol = initial[15]!.indexOf('Tab filter');
    const cancelCol = initial[15]!.indexOf('Q/Esc');
    const task2Row = initial.findIndex((row) => row.includes('bash-00000002'));
    expect(filterHeaderCol).toBeGreaterThan(0);
    expect(openCol).toBeGreaterThan(0);
    expect(stopCol).toBeGreaterThan(0);
    expect(refreshCol).toBeGreaterThan(0);
    expect(filterFooterCol).toBeGreaterThan(0);
    expect(cancelCol).toBeGreaterThan(0);
    expect(task2Row).toBeGreaterThan(1);

    vi.setSystemTime(10_400);
    click(vt, filterHeaderCol + 2, headerRow1);
    await vt.waitForRender();
    expect(onToggleFilter).toHaveBeenCalledTimes(1);

    vi.setSystemTime(11_000);
    click(vt, filterFooterCol + 2, footerRow1);
    await vt.waitForRender();
    expect(onToggleFilter).toHaveBeenCalledTimes(2);

    vi.setSystemTime(11_600);
    click(vt, refreshCol + 2, footerRow1);
    await vt.waitForRender();
    expect(onRefresh).toHaveBeenCalledTimes(1);

    vi.setSystemTime(12_200);
    click(vt, openCol + 2, footerRow1);
    await vt.waitForRender();
    expect(onOpenOutput).toHaveBeenCalledWith('bash-00000001');

    vi.setSystemTime(12_800);
    click(vt, stopCol + 1, footerRow1);
    await vt.waitForRender();
    const confirmRows = readRows();
    expect(confirmRows[15]).toContain('Stop bash-00000001?');

    vi.setSystemTime(13_200);
    click(vt, 6, task2Row + 1);
    click(vt, filterHeaderCol + 2, headerRow1);
    await vt.waitForRender();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleFilter).toHaveBeenCalledTimes(2);
    expect(readRows()[15]).toContain('Stop bash-00000001?');

    const cancelConfirmCol = confirmRows[15]!.indexOf('N/esc');
    expect(cancelConfirmCol).toBeGreaterThan(0);
    click(vt, cancelConfirmCol + 1, footerRow1);
    await vt.waitForRender();
    expect(onStopConfirmed).not.toHaveBeenCalled();
    expect(readRows()[15]).not.toContain('Stop bash-00000001?');

    vi.setSystemTime(13_800);
    click(vt, stopCol + 1, footerRow1);
    await vt.waitForRender();
    const confirmRows2 = readRows();
    const confirmYesCol = confirmRows2[15]!.indexOf('Y confirm');
    expect(confirmYesCol).toBeGreaterThan(0);

    vi.setSystemTime(14_200);
    click(vt, confirmYesCol + 1, footerRow1);
    await vt.waitForRender();
    expect(onStopConfirmed).toHaveBeenCalledTimes(1);
    expect(onStopConfirmed).toHaveBeenCalledWith('bash-00000001');
    expect(readRows()[15]).not.toContain('Stop bash-00000001?');

    vi.setSystemTime(14_800);
    click(vt, cancelCol + 1, footerRow1);
    await vt.waitForRender();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
