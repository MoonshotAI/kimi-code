import type { BackgroundTaskInfo, Session } from '@moonshot-ai/kimi-code-sdk';
import type { Component, ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import { TaskOutputViewer } from '../components/dialogs/task-output-viewer';
import { TasksBrowserApp, type TasksFilter } from '../components/dialogs/tasks-browser';
import type { Theme } from '#/tui/theme';
import type { CustomEditor } from '../components/editor/custom-editor';

export interface TasksBrowserHost {
  readonly state: {
    readonly tasksBrowser: TasksBrowserState | undefined;
    readonly theme: Theme;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
  };
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly session: Session | undefined;
  showError(msg: string): void;
  setTasksBrowser(value: TasksBrowserState | undefined): void;
}

export type TasksBrowserState = {
  component: TasksBrowserApp;
  savedChildren: readonly Component[];
  filter: TasksFilter;
  selectedTaskId: string | undefined;
  tailOutput: string | undefined;
  tailLoading: boolean;
  tailRequestId: number;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  pollTimer: NodeJS.Timeout | undefined;
  viewer:
    | {
        component: TaskOutputViewer;
        savedChildren: readonly Component[];
        taskId: string;
        output: string;
        refreshId: number;
        pollTimer: NodeJS.Timeout;
      }
    | undefined;
};

export class TasksBrowserController {
  constructor(private readonly host: TasksBrowserHost) {}

  async show(): Promise<void> {
    const { state } = this.host;
    if (state.tasksBrowser !== undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.host.showError('No active session.');
      return;
    }

    let tasks: readonly BackgroundTaskInfo[] = [];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      this.host.showError(
        `Failed to load tasks: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (state.tasksBrowser !== undefined) return;

    const filter: TasksFilter = 'all';
    const selectedTaskId = this.pickInitialSelection(tasks, filter);
    const component = new TasksBrowserApp(
      {
        tasks,
        filter,
        selectedTaskId,
        tailOutput: undefined,
        tailLoading: false,
        flashMessage: undefined,
        ...this.buildCallbacks(),
      },
      state.terminal,
    );

    const savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refresh({ silent: true });
    }, 1000);

    this.host.setTasksBrowser({
      component,
      savedChildren,
      filter,
      selectedTaskId,
      tailOutput: undefined,
      tailLoading: false,
      tailRequestId: 0,
      flashMessage: undefined,
      flashTimer: undefined,
      pollTimer,
      viewer: undefined,
    });

    if (selectedTaskId !== undefined) {
      this.loadTail(selectedTaskId);
    }
  }

  close(): void {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.viewer !== undefined) this.closeOutputViewer();
    if (browser.pollTimer !== undefined) clearInterval(browser.pollTimer);
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);

    state.ui.clear();
    for (const child of browser.savedChildren) {
      state.ui.addChild(child);
    }
    this.host.setTasksBrowser(undefined);
    state.ui.setFocus(state.editor);
    state.ui.requestRender(true);
  }

  repaint(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    const tasks = [...this.host.backgroundTasks.values()];
    this.pushProps(tasks);
  }

  async refreshOutputViewer(opts: { silent?: boolean } = {}): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    const viewer = browser?.viewer;
    if (browser === undefined || viewer === undefined) return;

    const session = this.host.session;
    if (session === undefined) return;

    const myRefreshId = ++viewer.refreshId;
    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(viewer.taskId);
    } catch (error) {
      if (!opts.silent) {
        const message = error instanceof Error ? error.message : String(error);
        this.flash(`Output refresh failed: ${message}`);
      }
      return;
    }
    const current = state.tasksBrowser?.viewer;
    if (current === undefined || current !== viewer || current.refreshId !== myRefreshId) {
      return;
    }
    if (output === viewer.output) return;
    viewer.output = output;
    const info = this.host.backgroundTasks.get(viewer.taskId);
    viewer.component.setProps({
      taskId: viewer.taskId,
      info,
      output,
      onClose: () => {
        this.closeOutputViewer();
      },
    });
    state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------

  private pickInitialSelection(
    tasks: readonly BackgroundTaskInfo[],
    filter: TasksFilter,
  ): string | undefined {
    const candidates =
      filter === 'all'
        ? tasks
        : tasks.filter(
            (t) =>
              t.status !== 'completed' &&
              t.status !== 'failed' &&
              t.status !== 'timed_out' &&
              t.status !== 'killed' &&
              t.status !== 'lost',
          );
    if (candidates.length === 0) return undefined;
    return candidates.find((t) => t.status === 'running')?.taskId ?? candidates[0]!.taskId;
  }

  private async refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) return;

    let tasks: readonly BackgroundTaskInfo[];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      if (!opts.silent) {
        this.flash(
          `Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (state.tasksBrowser !== browser) return;
    this.pushProps(tasks);
  }

  private pushProps(tasks: readonly BackgroundTaskInfo[]): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    browser.component.setProps({
      tasks,
      filter: browser.filter,
      selectedTaskId: browser.selectedTaskId,
      tailOutput: browser.tailOutput,
      tailLoading: browser.tailLoading,
      flashMessage: browser.flashMessage,
      ...this.buildCallbacks(),
    });
    this.host.state.ui.requestRender();
  }

  private buildCallbacks(): {
    onSelect: (taskId: string) => void;
    onToggleFilter: () => void;
    onRefresh: () => void;
    onCancel: () => void;
    onStopConfirmed: (taskId: string) => void;
    onOpenOutput: (taskId: string) => void;
    onStopIgnored: (taskId: string, reason: 'terminal') => void;
  } {
    return {
      onSelect: (taskId) => {
        this.handleSelect(taskId);
      },
      onToggleFilter: () => {
        this.handleToggleFilter();
      },
      onRefresh: () => {
        this.handleRefresh();
      },
      onCancel: () => {
        this.close();
      },
      onStopConfirmed: (taskId) => {
        void this.handleStop(taskId);
      },
      onOpenOutput: (taskId) => {
        void this.handleOpenOutput(taskId);
      },
      onStopIgnored: (taskId, reason) => {
        if (reason === 'terminal') {
          this.flash(`${taskId} is already terminal — nothing to stop.`);
        }
      },
    };
  }

  private handleSelect(taskId: string): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.selectedTaskId === taskId) return;
    browser.selectedTaskId = taskId;
    browser.tailOutput = undefined;
    browser.tailLoading = true;
    this.repaint();
    this.loadTail(taskId);
  }

  private handleToggleFilter(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    browser.filter = browser.filter === 'all' ? 'active' : 'all';
    this.repaint();
  }

  private handleRefresh(): void {
    this.flash('Refreshing…', 600);
    void this.refresh();
  }

  private async handleStop(taskId: string): Promise<void> {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.flash('No active session.');
      return;
    }

    this.flash(`Stopping ${taskId}…`, 1500);
    try {
      await session.stopBackgroundTask(taskId, { reason: 'User initiated stop' });
      await this.refresh({ silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flash(`Stop failed: ${message}`);
    }
  }

  private async handleOpenOutput(taskId: string): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.viewer !== undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.flash('No active session.');
      return;
    }

    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flash(`Cannot open output: ${message}`);
      return;
    }
    const current = state.tasksBrowser;
    if (current === undefined || current !== browser) return;

    const info = this.host.backgroundTasks.get(taskId);
    const viewer = new TaskOutputViewer(
      {
        taskId,
        info,
        output,
        onClose: () => {
          this.closeOutputViewer();
        },
      },
      state.terminal,
    );

    const savedBrowserChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(viewer);
    state.ui.setFocus(viewer);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refreshOutputViewer({ silent: true });
    }, 1000);

    browser.viewer = {
      component: viewer,
      savedChildren: savedBrowserChildren,
      taskId,
      output,
      refreshId: 0,
      pollTimer,
    };
  }

  private loadTail(taskId: string): void {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      browser.tailLoading = false;
      this.repaint();
      return;
    }

    const requestId = ++browser.tailRequestId;
    void session
      .getBackgroundTaskOutput(taskId, { tail: 4000 })
      .then((output) => {
        const current = state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = output;
        current.tailLoading = false;
        this.repaint();
      })
      .catch(() => {
        const current = state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = '';
        current.tailLoading = false;
        this.repaint();
      });
  }

  private flash(message: string, durationMs = 2500): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
    browser.flashMessage = message;
    browser.flashTimer = setTimeout(() => {
      const current = this.host.state.tasksBrowser;
      if (current !== browser) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.repaint();
    }, durationMs);
    this.repaint();
  }

  private closeOutputViewer(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined || browser.viewer === undefined) return;
    const viewer = browser.viewer;
    clearInterval(viewer.pollTimer);
    browser.viewer = undefined;
    this.host.state.ui.clear();
    for (const child of viewer.savedChildren) {
      this.host.state.ui.addChild(child);
    }
    this.host.state.ui.setFocus(browser.component);
    this.host.state.ui.requestRender(true);
  }
}
