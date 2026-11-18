import type { AgentBackgroundTaskInfo, BackgroundTaskInfo, Session } from '@moonshot-ai/kimi-code-sdk';
import type { ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import {
  AgentActivityViewer,
  formatSubagentActivityPreview,
} from '../components/dialogs/agent-activity-viewer';
import { TaskOutputViewer } from '../components/dialogs/task-output-viewer';
import {
  isVisibleTask,
  TasksBrowserApp,
  type TasksFilter,
} from '../components/dialogs/tasks-browser';
import type { Theme } from '#/tui/theme';
import type { CustomEditor } from '../components/editor/custom-editor';
import type { AppState } from '../types';
import {
  beginScreenTakeover,
  endScreenTakeover,
  type ScreenTakeover,
} from '../utils/screen-takeover';
import type { SessionEventHandler } from './session-event-handler';
import type { SubagentActivityRecord } from './subagent-activity-store';

export interface TasksBrowserHost {
  readonly state: {
    readonly tasksBrowser: TasksBrowserState | undefined;
    readonly theme: Theme;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
    readonly appState: Pick<AppState, 'availableModels'>;
  };
  readonly sessionEventHandler: SessionEventHandler;
  readonly session: Session | undefined;
  showError(msg: string): void;
  setTasksBrowser(value: TasksBrowserState | undefined): void;
}

type TaskViewer = {
  takeover: ScreenTakeover;
  taskId: string;
  pollTimer: NodeJS.Timeout;
} & (
  | {
      kind: 'agent';
      component: AgentActivityViewer;
      record?: SubagentActivityRecord;
    }
  | { kind: 'output'; component: TaskOutputViewer; output: string; refreshId: number }
);

export type TasksBrowserState = {
  component: TasksBrowserApp;
  takeover: ScreenTakeover;
  tasks: Map<string, BackgroundTaskInfo>;
  tasksRevision: number;
  filter: TasksFilter;
  selectedTaskId: string | undefined;
  tailOutput: string | undefined;
  tailLoading: boolean;
  tailRequestId: number;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  pollTimer: NodeJS.Timeout | undefined;
  viewer: TaskViewer | undefined;
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
        tailLoading: selectedTaskId !== undefined,
        flashMessage: undefined,
        availableModels: state.appState.availableModels,
        ...this.buildCallbacks(),
      },
      state.terminal,
    );

    const takeover = beginScreenTakeover(state.ui, component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refresh({ silent: true });
    }, 1000);

    this.host.setTasksBrowser({
      component,
      takeover,
      tasks: new Map(tasks.map((task) => [task.taskId, task])),
      tasksRevision: 0,
      filter,
      selectedTaskId,
      tailOutput: undefined,
      tailLoading: selectedTaskId !== undefined,
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

    endScreenTakeover(state.ui, browser.takeover);
    this.host.setTasksBrowser(undefined);
    state.ui.setFocus(state.editor);
    state.ui.requestRender(true);
  }

  repaint(info?: BackgroundTaskInfo): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (info !== undefined) {
      browser.tasks.set(info.taskId, info);
      browser.tasksRevision += 1;
      if (browser.viewer?.taskId === info.taskId) {
        void this.refreshOutputViewer();
      }
    }
    const selected = browser.selectedTaskId === undefined
      ? undefined
      : browser.tasks.get(browser.selectedTaskId);
    if (selected === undefined || !isVisibleTask(selected, browser.filter)) {
      const next = this.pickInitialSelection([...browser.tasks.values()], browser.filter);
      if (next !== browser.selectedTaskId) {
        this.handleSelect(next);
        return;
      }
    }
    this.pushProps(browser);
  }

  onSubagentSettled(record: SubagentActivityRecord): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    const task = [...browser.tasks.values()].find((info) =>
      info.kind === 'agent' && info.detached === false && info.agentId === record.agentId &&
      (info.parentToolCallId === undefined || info.parentToolCallId === record.parentToolCallId),
    );
    if (task === undefined) return;

    browser.tasks.delete(task.taskId);
    browser.tasksRevision += 1;
    const viewer = browser.viewer;
    if (viewer?.kind === 'agent' && viewer.taskId === task.taskId) {
      viewer.record = record;
      this.refreshAgentActivityViewer(browser, viewer);
    }
    this.repaint();
  }

  private async refreshOutputViewer(): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    const viewer = browser?.viewer;
    if (browser === undefined || viewer === undefined) return;
    if (viewer.kind === 'agent') {
      this.refreshAgentActivityViewer(browser, viewer);
      return;
    }

    const session = this.host.session;
    if (session === undefined) return;

    const myRefreshId = ++viewer.refreshId;
    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(viewer.taskId);
    } catch {
      return;
    }
    const current = state.tasksBrowser?.viewer;
    if (current !== viewer || viewer.refreshId !== myRefreshId) return;
    if (output === viewer.output) return;
    viewer.output = output;
    const info = browser.tasks.get(viewer.taskId);
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

  private pickInitialSelection(
    tasks: readonly BackgroundTaskInfo[],
    filter: TasksFilter,
  ): string | undefined {
    const candidates = tasks.filter((task) => isVisibleTask(task, filter));
    if (candidates.length === 0) return undefined;
    return candidates.find((t) => t.status === 'running')?.taskId ?? candidates[0]!.taskId;
  }

  private async refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) return;

    const revision = browser.tasksRevision;
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
    if (state.tasksBrowser !== browser || browser.tasksRevision !== revision) return;
    browser.tasksRevision += 1;
    browser.tasks = new Map(tasks.map((task) => [task.taskId, task]));
    this.syncAgentPreview(browser);
    this.repaint();
  }

  private agentActivity(info: BackgroundTaskInfo | undefined): SubagentActivityRecord | undefined {
    if (info?.kind !== 'agent' || info.agentId === undefined) return undefined;
    return this.host.sessionEventHandler.subAgentEventHandler.activityStore.get(
      info.agentId,
      info.parentToolCallId,
    );
  }

  private syncAgentPreview(browser: TasksBrowserState): boolean {
    if (browser.selectedTaskId === undefined) return false;
    const record = this.agentActivity(browser.tasks.get(browser.selectedTaskId));
    if (record === undefined) return false;
    browser.tailOutput = formatSubagentActivityPreview(record);
    browser.tailLoading = false;
    return true;
  }

  private pushProps(browser: TasksBrowserState): void {
    browser.component.setProps({
      tasks: [...browser.tasks.values()],
      filter: browser.filter,
      selectedTaskId: browser.selectedTaskId,
      tailOutput: browser.tailOutput,
      tailLoading: browser.tailLoading,
      flashMessage: browser.flashMessage,
      availableModels: this.host.state.appState.availableModels,
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

  private handleSelect(taskId: string | undefined): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.selectedTaskId === taskId) return;
    browser.selectedTaskId = taskId;
    browser.tailOutput = undefined;
    browser.tailLoading = taskId !== undefined;
    this.pushProps(browser);
    if (taskId !== undefined) this.loadTail(taskId);
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
    if (browser === undefined || browser.tasks.get(taskId)?.detached === false) return;

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

    const info = browser.tasks.get(taskId);
    if (info?.kind === 'agent') {
      const record = this.agentActivity(info);
      if (record !== undefined || info.detached === false) {
        this.openAgentActivityViewer(browser, info, record);
        return;
      }
    }

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
    if (current !== browser || current.viewer !== undefined) return;

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

    const takeover = beginScreenTakeover(state.ui, viewer);
    state.ui.setFocus(viewer);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refreshOutputViewer();
    }, 1000);

    browser.viewer = {
      kind: 'output',
      component: viewer,
      takeover,
      taskId,
      output,
      refreshId: 0,
      pollTimer,
    };
  }

  private openAgentActivityViewer(
    browser: TasksBrowserState,
    info: AgentBackgroundTaskInfo,
    record: SubagentActivityRecord | undefined,
  ): void {
    const { state } = this.host;

    const viewer = new AgentActivityViewer(
      {
        taskId: info.taskId,
        info,
        record,
        onClose: () => {
          this.closeOutputViewer();
        },
      },
      state.terminal,
    );

    const takeover = beginScreenTakeover(state.ui, viewer);
    state.ui.setFocus(viewer);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refreshOutputViewer();
    }, 1000);

    browser.viewer = {
      kind: 'agent',
      component: viewer,
      takeover,
      taskId: info.taskId,
      record,
      pollTimer,
    };
  }

  private refreshAgentActivityViewer(
    browser: TasksBrowserState,
    viewer: Extract<TaskViewer, { kind: 'agent' }>,
  ): void {
    const info = browser.tasks.get(viewer.taskId);
    viewer.record ??= this.agentActivity(info);
    viewer.component.setProps({
      taskId: viewer.taskId,
      info,
      record: viewer.record,
      onClose: () => {
        this.closeOutputViewer();
      },
    });
    this.host.state.ui.requestRender();
  }

  private loadTail(taskId: string): void {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    if (this.syncAgentPreview(browser)) {
      this.pushProps(browser);
      return;
    }

    const session = this.host.session;
    if (session === undefined) {
      browser.tailLoading = false;
      this.pushProps(browser);
      return;
    }

    const requestId = ++browser.tailRequestId;
    void session
      .getBackgroundTaskOutput(taskId, { tail: 4000 })
      .then((output) => {
        const current = state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId || !current.tailLoading) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = output;
        current.tailLoading = false;
        this.pushProps(current);
      })
      .catch(() => {
        const current = state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId || !current.tailLoading) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = '';
        current.tailLoading = false;
        this.pushProps(current);
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
    endScreenTakeover(this.host.state.ui, viewer.takeover);
    this.host.state.ui.setFocus(browser.component);
    this.host.state.ui.requestRender(true);
  }
}
