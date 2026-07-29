/**
 * Scenario: users inspect and control background tasks through the /tasks browser.
 * Responsibilities: render task/output state, route keyboard actions, and keep previews fresh.
 * Wiring: the real browser component/controller with only the SDK Session boundary stubbed.
 * Run: pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/tasks-browser.test.ts
 */
import type {
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  Session,
} from '@moonshot-ai/kimi-code-sdk';
import type { Component, ProcessTerminal, Terminal, TUI } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TasksBrowserApp,
  type TasksBrowserProps,
  type TasksFilter,
} from '@/tui/components/dialogs/tasks-browser';
import {
  TasksBrowserController,
  type TasksBrowserHost,
  type TasksBrowserState,
} from '@/tui/controllers/tasks-browser';
import type { CustomEditor } from '@/tui/components/editor/custom-editor';
import type { Theme } from '@/tui/theme';

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function controllerRig(options: {
  getOutput: ReturnType<typeof vi.fn>;
  tasks?: BackgroundTaskInfo[];
  listTasks?: ReturnType<typeof vi.fn>;
}): {
  controller: TasksBrowserController;
  get browser(): TasksBrowserState | undefined;
  backgroundTasks: Map<string, BackgroundTaskInfo>;
  poll(): void;
} {
  let browser: TasksBrowserState | undefined;
  let children: Component[] = [];
  let poll = () => {};
  const ui = {
    get children() {
      return children;
    },
    clear() {
      children = [];
    },
    addChild(child: Component) {
      children.push(child);
    },
    setFocus: vi.fn(),
    requestRender: vi.fn(),
  } as unknown as TUI;
  const tasks = options.tasks ?? [task({ taskId: 'bash-live', detached: true })];
  const session = {
    listBackgroundTasks: options.listTasks ?? vi.fn().mockResolvedValue(tasks),
    getBackgroundTaskOutput: options.getOutput,
  } as unknown as Session;
  const backgroundTasks = new Map(
    tasks.map((backgroundTask) => [backgroundTask.taskId, backgroundTask]),
  );
  const host: TasksBrowserHost = {
    state: {
      get tasksBrowser() {
        return browser;
      },
      theme: {} as Theme,
      terminal: fakeTerminal(30) as ProcessTerminal,
      ui,
      editor: {} as CustomEditor,
    },
    backgroundTasks,
    session,
    showError: vi.fn(),
    setTasksBrowser(value) {
      browser = value;
    },
  };
  const controller = new TasksBrowserController(host, {
    start(callback) {
      poll = callback;
      return {} as NodeJS.Timeout;
    },
    stop() {},
  });
  return {
    controller,
    backgroundTasks,
    poll() {
      poll();
    },
    get browser() {
      return browser;
    },
  };
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

  it('shows a preview load failure distinctly from an empty output', () => {
    const out = strip(
      makeApp({
        tasks: [task({ taskId: 'bash-aaaaaaaa' })],
        selectedTaskId: 'bash-aaaaaaaa',
        tailError: 'permission denied',
      })
        .render(120)
        .join('\n'),
    );
    expect(out).toContain('Preview unavailable: permission denied');
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

describe('TasksBrowserController — preview freshness', () => {
  let controller: TasksBrowserController | undefined;

  afterEach(() => {
    controller?.close();
    controller = undefined;
  });

  it('reloads the selected preview when task events repaint the browser', async () => {
    const getOutput = vi
      .fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('agent final result');
    const rig = controllerRig({ getOutput });
    controller = rig.controller;

    await controller.show();
    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledTimes(1);
    });
    controller.repaint();

    await vi.waitFor(() => {
      expect(strip(rig.browser!.component.render(120).join('\n'))).toContain(
        'agent final result',
      );
    });
  });

  it('shows slow process stdout after task events repaint the browser', async () => {
    const pendingOutput = deferred<string>();
    const getOutput = vi.fn().mockReturnValue(pendingOutput.promise);
    const rig = controllerRig({ getOutput });
    controller = rig.controller;

    await controller.show();
    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledTimes(1);
    });
    controller.repaint();
    expect(getOutput).toHaveBeenCalledTimes(1);
    pendingOutput.resolve('slow process output');

    await vi.waitFor(() => {
      expect(strip(rig.browser!.component.render(120).join('\n'))).toContain(
        'slow process output',
      );
    });
  });

  it('reloads final output after a terminal event interrupts an in-flight preview', async () => {
    const runningOutput = deferred<string>();
    const finalOutput = deferred<string>();
    const runningTask = task({
      taskId: 'bash-in-flight',
      detached: true,
      status: 'running',
    });
    const getOutput = vi
      .fn()
      .mockReturnValueOnce(runningOutput.promise)
      .mockReturnValueOnce(finalOutput.promise)
      .mockResolvedValueOnce('unexpected third output');
    const rig = controllerRig({ getOutput, tasks: [runningTask] });
    controller = rig.controller;

    await controller.show();
    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledTimes(1);
    });
    rig.backgroundTasks.set(
      runningTask.taskId,
      task({
        taskId: runningTask.taskId,
        detached: true,
        status: 'completed',
      }),
    );
    controller.repaint();
    runningOutput.resolve('pre-termination output');

    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledTimes(2);
    });
    controller.repaint();
    finalOutput.resolve('final output');
    await vi.waitFor(() => {
      expect(strip(rig.browser!.component.render(120).join('\n'))).toContain(
        'final output',
      );
    });
    expect(getOutput).toHaveBeenCalledTimes(2);
  });

  it('does not poll output again after the selected task is terminal', async () => {
    const completedTask = task({
      taskId: 'bash-complete',
      detached: true,
      status: 'completed',
    });
    const getOutput = vi.fn().mockResolvedValue('final process output');
    const rig = controllerRig({ getOutput, tasks: [completedTask] });
    controller = rig.controller;

    await controller.show();
    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledTimes(1);
    });
    rig.poll();

    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledTimes(1);
    });
  });

  it('ignores a stale running poll after a terminal event reloads final output', async () => {
    const stalePoll = deferred<BackgroundTaskInfo[]>();
    const runningTask = task({
      taskId: 'bash-transition',
      detached: true,
      status: 'running',
    });
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce([runningTask])
      .mockReturnValueOnce(stalePoll.promise);
    const getOutput = vi
      .fn()
      .mockResolvedValueOnce('running output')
      .mockResolvedValueOnce('final output')
      .mockResolvedValueOnce('unexpected extra output');
    const rig = controllerRig({ getOutput, tasks: [runningTask], listTasks });
    controller = rig.controller;

    await controller.show();
    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledTimes(1);
    });
    rig.poll();
    await vi.waitFor(() => {
      expect(listTasks).toHaveBeenCalledTimes(2);
    });
    rig.backgroundTasks.set(
      runningTask.taskId,
      task({
        taskId: runningTask.taskId,
        detached: true,
        status: 'completed',
      }),
    );
    controller.repaint();
    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledTimes(2);
    });
    stalePoll.resolve([runningTask]);
    await stalePoll.promise;

    expect(getOutput).toHaveBeenCalledTimes(2);
  });

  it('opens the full output viewer without applying the preview tail limit', async () => {
    const getOutput = vi.fn().mockResolvedValue('complete task output');
    const rig = controllerRig({ getOutput });
    controller = rig.controller;

    await controller.show();
    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenNthCalledWith(1, 'bash-live', { tail: 4000 });
    });
    rig.browser!.component.handleInput('o');

    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenNthCalledWith(2, 'bash-live');
    });
  });

  it('retries a failed preview load when the user presses R', async () => {
    const getOutput = vi
      .fn()
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce('retry succeeded');
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce([task({ taskId: 'bash-live', detached: true })])
      .mockRejectedValueOnce(new Error('metadata unavailable'));
    const rig = controllerRig({ getOutput, listTasks });
    controller = rig.controller;

    await controller.show();
    await vi.waitFor(() => {
      expect(strip(rig.browser!.component.render(120).join('\n'))).toContain(
        'Preview unavailable: permission denied',
      );
    });
    rig.browser!.component.handleInput('r');

    await vi.waitFor(() => {
      expect(strip(rig.browser!.component.render(120).join('\n'))).toContain(
        'retry succeeded',
      );
    });
  });

  it('ignores a stale preview response after the selected task changes', async () => {
    const firstOutput = deferred<string>();
    const secondOutput = deferred<string>();
    const tasks = [
      task({ taskId: 'bash-first', detached: true, startedAt: 1 }),
      task({ taskId: 'bash-second', detached: true, startedAt: 2 }),
    ];
    const getOutput = vi.fn((taskId: string) =>
      taskId === 'bash-first' ? firstOutput.promise : secondOutput.promise,
    );
    const rig = controllerRig({ getOutput, tasks });
    controller = rig.controller;

    await controller.show();
    await vi.waitFor(() => {
      expect(getOutput).toHaveBeenCalledWith('bash-first', { tail: 4000 });
    });
    rig.browser!.component.handleInput('j');
    secondOutput.resolve('selected task output');
    await vi.waitFor(() => {
      expect(strip(rig.browser!.component.render(120).join('\n'))).toContain(
        'selected task output',
      );
    });
    firstOutput.resolve('stale task output');

    await vi.waitFor(() => {
      const rendered = strip(rig.browser!.component.render(120).join('\n'));
      expect(rendered).toContain('selected task output');
      expect(rendered).not.toContain('stale task output');
    });
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
