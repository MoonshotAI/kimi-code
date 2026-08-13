import type { Terminal } from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo, BackgroundTaskStatus, Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  TasksBrowserApp,
  type TasksBrowserProps,
  type TasksFilter,
} from '@/tui/components/dialogs/tasks-browser';
import { AgentActivityViewer } from '@/tui/components/dialogs/agent-activity-viewer';
import { TaskOutputViewer } from '@/tui/components/dialogs/task-output-viewer';
import { SubagentActivityStore } from '@/tui/controllers/subagent-activity-store';
import { TasksBrowserController } from '@/tui/controllers/tasks-browser';
import { darkColors } from '@/tui/theme/colors';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

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
    // Two terminals with different heights — verify render adapts.
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
    // 10 rows = the smallest terminal that still renders the full layout; the
    // render must emit exactly that many lines (no overflow truncation).
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
    expect(out).toContain('No background tasks');
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

  it('filters out foreground tasks (detached === false)', () => {
    const tasks = [
      task({ taskId: 'bash-foreground', detached: false, status: 'running' }),
      task({ taskId: 'bash-background', detached: true, status: 'running' }),
    ];
    const out = strip(makeApp({ tasks, filter: 'all' }).render(120).join('\n'));
    expect(out).not.toContain('bash-foreground');
    expect(out).toContain('bash-background');
  });

  it('keeps background tasks with detached === true even when terminal', () => {
    const tasks = [task({ taskId: 'bash-done', detached: true, status: 'completed' })];
    const out = strip(makeApp({ tasks, filter: 'all' }).render(120).join('\n'));
    expect(out).toContain('bash-done');
  });

  it('keeps ghost tasks whose detached field is undefined', () => {
    // task() leaves `detached` undefined by default, mimicking reconcile ghosts.
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
    app.handleInput('[B'); // ↓
    expect(onSelect).toHaveBeenLastCalledWith('bash-bbbbbbbb');
    app.handleInput('j');
    expect(onSelect).toHaveBeenLastCalledWith('bash-cccccccc');
    app.handleInput('[A'); // ↑
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

// When a terminal (e.g. the VSCode integrated terminal) enables the Kitty
// keyboard protocol disambiguate flag, ordinary printable keys arrive as
// CSI-u sequences: `r` → "\x1b[114u", `q` → "\x1b[113u". These tests pin
// down that the tasks panel's literal-character shortcuts still fire
// under Kitty mode.
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
    app.handleInput('[B'); // ↓ arrow should be swallowed
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
      tasksBrowser: undefined as unknown,
      terminal: fakeTerminal(30),
      ui,
      editor: {},
    };
    const host = {
      state,
      backgroundTasks: new Map(tasks.map((t) => [t.taskId, t])),
      sessionEventHandler: { subAgentEventHandler: { activityStore: store } },
      session: {
        listBackgroundTasks: async () => tasks,
        getBackgroundTaskOutput: async () => 'captured output',
      },
      showError: vi.fn(),
      setTasksBrowser(value: unknown) {
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
      args: { pattern: 'foo' },
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
    expect(browser.tailOutput).toContain('✓ Used Grep (foo) · 2 matches');
    controller.close();
  });
});
