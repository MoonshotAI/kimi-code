import type { AgentHandle } from '@moonshot-ai/agent-core';
import { extractText, type HistoryMessage } from '@moonshot-ai/agent-core';
import { watch } from '@moonshot-ai/agent-core/kernel/index';
import { TaskRef, type TaskFace, type TaskRecord } from '@moonshot-ai/harness-core';
import type { KimiSession } from '@moonshot-ai/kimi-code-sdk';

import { TaskOutputViewer } from '../components/dialogs/task-output-viewer';
import {
  previewOutputOf,
  TasksBrowserApp,
  type TaskRow,
  type TasksFilter,
} from '../components/dialogs/tasks-browser';
import { extractKeyArgument } from '../components/messages/tool-call';
import type { TUIState } from '../tui-state';
import {
  beginScreenTakeover,
  endScreenTakeover,
  type ScreenTakeover,
} from '../utils/screen-takeover';

export interface TasksBrowserHost {
  readonly state: TUIState;
  readonly session: KimiSession | undefined;
  mainAgent(): AgentHandle | undefined;
  showError(msg: string): void;
}

const MAX_ACTIVITY_ENTRIES = 40;
const MAX_ACTIVITY_CHARS = 20_000;

interface BrowserState {
  component: TasksBrowserApp;
  takeover: ScreenTakeover;
  face: TaskFace;
  stopWatch: () => void;
  filter: TasksFilter;
  selectedTaskId: string | undefined;
  flashMessage: string | undefined;
  flashTimer: ReturnType<typeof setTimeout> | undefined;
  viewer:
    | {
        component: TaskOutputViewer;
        takeover: ScreenTakeover;
        taskId: string;
        agentId?: string;
        stopWatch?: () => void;
      }
    | undefined;
}

export class TasksBrowserController {
  private browser: BrowserState | undefined;

  constructor(private readonly host: TasksBrowserHost) {}

  isOpen(): boolean {
    return this.browser !== undefined;
  }

  show(): void {
    if (this.browser !== undefined) return;
    const { state } = this.host;
    const main = this.host.mainAgent();
    if (main === undefined) {
      this.host.showError('No active session.');
      return;
    }
    const face = main.resolve(TaskRef);
    if (face === undefined) {
      this.host.showError('Background tasks are not available in this session.');
      return;
    }

    const rows = this.rowsFromRecords(face.records.value);
    const selectedTaskId = this.pickInitialSelection(rows, 'all');
    const component = new TasksBrowserApp(
      {
        tasks: rows,
        filter: 'all',
        selectedTaskId,
        flashMessage: undefined,
        ...this.buildCallbacks(),
      },
      state.terminal,
    );
    const takeover = beginScreenTakeover(state.ui, component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const browser: BrowserState = {
      component,
      takeover,
      face,
      stopWatch: () => {},
      filter: 'all',
      selectedTaskId,
      flashMessage: undefined,
      flashTimer: undefined,
      viewer: undefined,
    };
    browser.stopWatch = watch(face.records, () => {
      this.repaint();
    });
    this.browser = browser;
  }

  close(): void {
    const browser = this.browser;
    if (browser === undefined) return;
    this.closeOutputViewer();
    browser.stopWatch();
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
    endScreenTakeover(this.host.state.ui, browser.takeover);
    this.browser = undefined;
    this.host.state.ui.setFocus(this.host.state.editor);
    this.host.state.ui.requestRender(true);
  }

  private repaint(): void {
    const browser = this.browser;
    if (browser === undefined) return;
    browser.component.setProps({
      tasks: this.rowsFromRecords(browser.face.records.value),
      filter: browser.filter,
      selectedTaskId: browser.selectedTaskId,
      flashMessage: browser.flashMessage,
      ...this.buildCallbacks(),
    });
    this.host.state.ui.requestRender();
  }

  private rowsFromRecords(records: ReadonlyMap<string, TaskRecord>): TaskRow[] {
    const rows: TaskRow[] = [];
    for (const record of records.values()) {
      rows.push({ record, agentId: agentIdOf(record) });
    }
    return rows;
  }

  private pickInitialSelection(rows: readonly TaskRow[], filter: TasksFilter): string | undefined {
    const candidates =
      filter === 'all' ? rows : rows.filter((row) => row.record.status === 'running');
    if (candidates.length === 0) return undefined;
    return (
      candidates.find((row) => row.record.status === 'running')?.record.taskId ??
      candidates[0]!.record.taskId
    );
  }

  private buildCallbacks(): {
    onSelect: (taskId: string) => void;
    onToggleFilter: () => void;
    onCancel: () => void;
    onStopConfirmed: (taskId: string) => void;
    onOpenOutput: (taskId: string) => void;
    onStopIgnored: (taskId: string, reason: 'terminal') => void;
  } {
    return {
      onSelect: (taskId) => {
        const browser = this.browser;
        if (browser === undefined || browser.selectedTaskId === taskId) return;
        browser.selectedTaskId = taskId;
        this.repaint();
      },
      onToggleFilter: () => {
        const browser = this.browser;
        if (browser === undefined) return;
        browser.filter = browser.filter === 'all' ? 'active' : 'all';
        this.repaint();
      },
      onCancel: () => {
        this.close();
      },
      onStopConfirmed: (taskId) => {
        void this.handleStop(taskId);
      },
      onOpenOutput: (taskId) => {
        this.openOutputViewer(taskId);
      },
      onStopIgnored: (taskId) => {
        this.flash(`${taskId} is already terminal — nothing to stop.`);
      },
    };
  }

  private async handleStop(taskId: string): Promise<void> {
    const browser = this.browser;
    if (browser === undefined) return;
    this.flash(`Stopping ${taskId}…`, 1500);
    const record = await browser.face.stop(taskId, 'User initiated stop').catch(() => undefined);
    if (record === undefined) {
      this.flash(`Stop failed: ${taskId} is not running.`);
    }
  }

  private openOutputViewer(taskId: string): void {
    const browser = this.browser;
    if (browser === undefined || browser.viewer !== undefined) return;
    const { state } = this.host;
    const row = this.rowsFromRecords(browser.face.records.value).find(
      (candidate) => candidate.record.taskId === taskId,
    );
    if (row === undefined) {
      this.flash(`Task ${taskId} no longer exists.`);
      return;
    }

    const isAgent = row.record.toolName === 'Agent' || row.record.toolName === 'AgentSwarm';
    const viewer = new TaskOutputViewer(
      {
        taskId,
        record: row.record,
        output: isAgent ? this.agentActivityOutput(row.agentId) : previewOutputOf(row),
        title: isAgent ? ' Agent activity ' : ' Task output ',
        onClose: () => {
          this.closeOutputViewer();
        },
      },
      state.terminal,
    );
    const takeover = beginScreenTakeover(state.ui, viewer);
    state.ui.setFocus(viewer);
    state.ui.requestRender(true);

    let stopWatch: (() => void) | undefined;
    if (isAgent && row.agentId !== undefined) {
      const store = this.host.session?.handle.stores.get(row.agentId);
      if (store !== undefined) {
        const agentId = row.agentId;
        stopWatch = store.onCommit(() => {
          const current = this.browser?.viewer;
          if (current === undefined || current.agentId !== agentId) return;
          current.component.setProps({
            taskId,
            record: this.browser?.face.records.value.get(taskId),
            output: this.agentActivityOutput(agentId),
            title: ' Agent activity ',
            onClose: () => {
              this.closeOutputViewer();
            },
          });
          this.host.state.ui.requestRender();
        });
      }
    }

    browser.viewer = { component: viewer, takeover, taskId, agentId: row.agentId, stopWatch };
  }

  private closeOutputViewer(): void {
    const browser = this.browser;
    if (browser === undefined || browser.viewer === undefined) return;
    const viewer = browser.viewer;
    viewer.stopWatch?.();
    browser.viewer = undefined;
    endScreenTakeover(this.host.state.ui, viewer.takeover);
    this.host.state.ui.setFocus(browser.component);
    this.host.state.ui.requestRender(true);
  }

  private agentActivityOutput(agentId: string | undefined): string {
    if (agentId === undefined) {
      return '[agent instance unavailable — its activity cannot be shown]';
    }
    const history = this.host.session?.handle.stores.get(agentId)?.getState().history;
    if (history === undefined) {
      return '[agent is not running — no live activity]';
    }
    return formatAgentActivityPreview(history);
  }

  private flash(message: string, durationMs = 2500): void {
    const browser = this.browser;
    if (browser === undefined) return;
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
    browser.flashMessage = message;
    browser.flashTimer = setTimeout(() => {
      const current = this.browser;
      if (current !== browser) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.repaint();
    }, durationMs);
    this.repaint();
  }
}

function agentIdOf(record: TaskRecord): string | undefined {
  if (record.toolName !== 'Agent' && record.toolName !== 'AgentSwarm') return undefined;
  const match = /^agent_id:\s*(\S+)/m.exec(record.detachText ?? '');
  return match?.[1];
}

export function formatAgentActivityPreview(history: readonly HistoryMessage[]): string {
  const tail = history.slice(-MAX_ACTIVITY_ENTRIES);
  const results = new Map<string, string>();
  for (const entry of tail) {
    if (entry.message.role === 'tool') {
      results.set(entry.message.toolCallId, extractText(entry.message));
    }
  }
  const lines: string[] = [];
  let chars = 0;
  const push = (line: string): boolean => {
    chars += line.length;
    if (chars > MAX_ACTIVITY_CHARS) return false;
    lines.push(line);
    return true;
  };
  for (const entry of tail) {
    if (entry.message.role === 'user') {
      const text = extractText(entry.message).trim();
      if (text.length === 0) continue;
      if (!push(`> ${text}`)) break;
      if (!push('')) break;
      continue;
    }
    if (entry.message.role !== 'assistant') continue;
    const text = extractText(entry.message).trimEnd();
    if (text.trim().length > 0) {
      for (const line of text.split('\n')) {
        if (!push(line)) break;
      }
    }
    for (const call of entry.message.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.arguments ?? '{}');
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {}
      const keyArg = extractKeyArgument(call.name, args);
      const suffix = keyArg === null ? '' : ` (${keyArg})`;
      if (!push(`● Used ${call.name}${suffix}`)) break;
      const output = results.get(call.id);
      const outcome = lastNonEmptyLine(output ?? '');
      if (outcome !== undefined) {
        if (!push(`  ⎿ ${outcome}`)) break;
      }
    }
    if (chars > MAX_ACTIVITY_CHARS) break;
  }
  return lines.length > 0 ? lines.join('\n') : '[no activity yet]';
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return lines.at(-1);
}
