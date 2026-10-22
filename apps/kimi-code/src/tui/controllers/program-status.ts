import { createHash } from 'node:crypto';

import type { ProgramStatus } from '@moonshot-ai/pi-tui';
import type {
  AgentBackgroundTaskInfo,
  BackgroundTaskInfo,
  TurnEndedEvent,
  TurnStartedEvent,
} from '@moonshot-ai/kimi-code-sdk';

import { PRODUCT_NAME } from '../constant/kimi-tui';
import type { AppState } from '../types';

const MAX_CHILD_RECORDS = 63;
const AUTH_BLOCKED: ProgramStatusBlocked = {
  kind: 'auth',
  message: 'Sign in to Kimi Code',
};

export interface ProgramStatusTerminal {
  setProgramStatus(status: ProgramStatus): void;
}

export interface ProgramStatusState {
  readonly appState: Pick<
    AppState,
    'isCompacting' | 'sessionTitle' | 'streamingPhase'
  >;
  readonly queuedMessages: readonly unknown[];
  readonly queuedMessageDispatchPending: boolean;
}

export interface ProgramStatusBlocked {
  readonly kind: 'permission' | 'question' | 'auth';
  readonly message: string;
}

export interface ProgramStatusInteraction {
  readonly agentId?: string;
  readonly kind: 'permission' | 'question';
}

export interface ProgramStatusInteractionTracker {
  startInteraction(interaction: ProgramStatusInteraction): symbol;
  endInteraction(token: symbol): void;
}

type WorkOutcome =
  | { readonly state: 'idle' }
  | { readonly state: 'done' }
  | { readonly state: 'error'; readonly message: string };

interface ChildBase {
  readonly id: string;
  readonly taskId: string;
  readonly agentId?: string;
  readonly title: string;
}

type SettledChild = ChildBase &
  (
    | { readonly status: 'done'; readonly settledOrder: number }
    | {
        readonly status: 'error';
        readonly message: string;
        readonly settledOrder: number;
      }
  );

type ChildWork = (ChildBase & { readonly status: 'running' }) | SettledChild;

export class ProgramStatusController implements ProgramStatusInteractionTracker {
  private readonly children = new Map<string, ChildWork>();
  private readonly interactions = new Map<symbol, ProgramStatusInteraction>();
  private readonly childReports = new Map<string, string>();
  private rootReport: string | undefined;
  private outcome: WorkOutcome = { state: 'idle' };
  private editorBlocked: ProgramStatusBlocked | undefined;
  private authBlocked = false;
  private settlementOrder = 0;

  constructor(
    private readonly state: ProgramStatusState,
    private readonly terminal: ProgramStatusTerminal,
  ) {}

  refresh(): void {
    this.pruneSettledChildren();
    this.publishRoot(this.rootStatus());
    const active = [...this.children.values()].filter((child) => child.status === 'running');
    const settled = [...this.children.values()]
      .filter(isSettledChild)
      .toSorted((a, b) => b.settledOrder - a.settledOrder);
    const selected = [...active, ...settled].slice(0, MAX_CHILD_RECORDS);
    const selectedIds = new Set<string>();
    for (const child of selected) {
      selectedIds.add(child.id);
      this.publishChild(this.childStatus(child));
    }
    for (const id of this.childReports.keys()) {
      if (selectedIds.has(id)) continue;
      this.terminal.setProgramStatus({ state: 'clear', id });
      this.childReports.delete(id);
    }
  }

  resetSession(): void {
    if (this.rootReport !== undefined || this.childReports.size > 0) {
      this.terminal.setProgramStatus({ state: 'clear' });
    }
    this.children.clear();
    this.interactions.clear();
    this.childReports.clear();
    this.rootReport = undefined;
    this.outcome = { state: 'idle' };
    this.editorBlocked = undefined;
    this.authBlocked = false;
    this.publishRoot({ state: 'idle', app: 'kimi-code' });
  }

  beginTurn(origin: TurnStartedEvent['origin'] | undefined): void {
    if (isExplicitUserTurn(origin)) {
      this.beginUserInstruction();
      return;
    }
    this.refresh();
  }

  beginUserInstruction(): void {
    this.clearSettledChildren();
    this.refresh();
  }

  finishTurn(event: TurnEndedEvent): void {
    switch (event.reason) {
      case 'completed':
        this.outcome = { state: 'done' };
        break;
      case 'cancelled':
        this.outcome = { state: 'idle' };
        break;
      case 'failed':
        this.outcome = {
          state: 'error',
          message: firstLine(event.error?.message) ?? 'Turn failed',
        };
        break;
      case 'blocked':
        this.outcome = {
          state: 'error',
          message: firstLine(event.error?.message) ?? 'Turn blocked by a prompt hook',
        };
        break;
    }
    this.refresh();
  }

  finishCompaction(cancelled: boolean): void {
    this.outcome = cancelled ? { state: 'idle' } : { state: 'done' };
    this.refresh();
  }

  failRequest(message: string): void {
    this.outcome = { state: 'error', message: firstLine(message) ?? 'Request failed' };
    this.refresh();
  }

  updateBackgroundTask(info: BackgroundTaskInfo): void {
    if (info.kind !== 'agent') return;
    const previous = this.children.get(info.taskId);
    const base = childBase(info, previous);
    if (info.status !== 'running') this.removeAgentInteractions(info.agentId);
    switch (info.status) {
      case 'running':
        this.children.set(info.taskId, { ...base, status: 'running' });
        break;
      case 'completed':
        this.children.set(info.taskId, {
          ...base,
          status: 'done',
          settledOrder: ++this.settlementOrder,
        });
        this.outcome = { state: 'done' };
        break;
      case 'failed':
      case 'timed_out':
      case 'lost': {
        const message =
          firstLine(info.stopReason) ??
          (info.status === 'failed'
            ? 'Background agent failed'
            : info.status === 'timed_out'
              ? 'Background agent timed out'
              : 'Background agent was lost');
        this.children.set(info.taskId, {
          ...base,
          status: 'error',
          message,
          settledOrder: ++this.settlementOrder,
        });
        this.outcome = { state: 'error', message };
        break;
      }
      case 'killed':
        this.children.delete(info.taskId);
        this.outcome = { state: 'idle' };
        break;
    }
    this.refresh();
  }

  restoreBackgroundTasks(tasks: readonly BackgroundTaskInfo[]): void {
    this.children.clear();
    this.interactions.clear();
    for (const info of tasks) {
      if (info.kind !== 'agent' || info.status !== 'running') continue;
      this.children.set(info.taskId, { ...childBase(info), status: 'running' });
    }
    this.refresh();
  }

  startInteraction(interaction: ProgramStatusInteraction): symbol {
    const token = Symbol(interaction.kind);
    this.interactions.set(token, interaction);
    this.refresh();
    return token;
  }

  endInteraction(token: symbol): void {
    if (!this.interactions.delete(token)) return;
    this.refresh();
  }

  setEditorBlocked(blocked: ProgramStatusBlocked | undefined): void {
    this.editorBlocked = blocked;
    this.refresh();
  }

  setAuthBlocked(blocked: boolean): void {
    this.authBlocked = blocked;
    this.refresh();
  }

  private rootStatus(): ProgramStatus {
    const blocked = this.editorBlocked ?? (this.authBlocked ? AUTH_BLOCKED : undefined);
    if (blocked !== undefined) {
      return { state: 'blocked', app: 'kimi-code', ...blocked };
    }
    if (this.hasAgentWork()) {
      return { state: 'working', app: 'kimi-code', message: this.sessionLabel() };
    }
    switch (this.outcome.state) {
      case 'idle':
        return { state: 'idle', app: 'kimi-code' };
      case 'done':
        return { state: 'done', app: 'kimi-code', message: this.sessionLabel() };
      case 'error':
        return { state: 'error', app: 'kimi-code', message: this.outcome.message };
    }
  }

  private childStatus(child: ChildWork): ProgramStatus {
    if (child.status === 'running') {
      const interaction = this.interactionFor(child.agentId);
      if (interaction !== undefined) {
        return {
          state: 'blocked',
          id: child.id,
          title: child.title,
          kind: interaction.kind,
          message: interaction.kind === 'permission' ? 'Approval required' : 'Answer required',
        };
      }
      return { state: 'working', id: child.id, title: child.title };
    }
    if (child.status === 'done') {
      return { state: 'done', id: child.id, title: child.title };
    }
    return {
      state: 'error',
      id: child.id,
      title: child.title,
      message: child.message,
    };
  }

  private hasAgentWork(): boolean {
    const { appState } = this.state;
    if (appState.isCompacting) return true;
    if (appState.streamingPhase !== 'idle' && appState.streamingPhase !== 'shell') return true;
    if (this.state.queuedMessages.length > 0 || this.state.queuedMessageDispatchPending) return true;
    return [...this.children.values()].some((child) => child.status === 'running');
  }

  private sessionLabel(): string {
    const title = this.state.appState.sessionTitle?.trim();
    return title === undefined || title.length === 0 ? PRODUCT_NAME : title;
  }

  private interactionFor(agentId: string | undefined): ProgramStatusInteraction | undefined {
    if (agentId === undefined) return undefined;
    for (const interaction of this.interactions.values()) {
      if (interaction.agentId === agentId) return interaction;
    }
    return undefined;
  }

  private removeAgentInteractions(agentId: string | undefined): void {
    if (agentId === undefined) return;
    for (const [token, interaction] of this.interactions) {
      if (interaction.agentId === agentId) this.interactions.delete(token);
    }
  }

  private clearSettledChildren(): void {
    for (const [taskId, child] of this.children) {
      if (child.status !== 'running') this.children.delete(taskId);
    }
  }

  private pruneSettledChildren(): void {
    const activeCount = [...this.children.values()].filter(
      (child) => child.status === 'running',
    ).length;
    const settled = [...this.children.values()]
      .filter(isSettledChild)
      .toSorted((a, b) => b.settledOrder - a.settledOrder);
    const keep = Math.max(0, MAX_CHILD_RECORDS - activeCount);
    for (const child of settled.slice(keep)) this.children.delete(child.taskId);
  }

  private publishRoot(status: ProgramStatus): void {
    const report = JSON.stringify(status);
    if (report === this.rootReport) return;
    this.terminal.setProgramStatus(status);
    this.rootReport = report;
  }

  private publishChild(status: ProgramStatus): void {
    if (status.id === undefined) return;
    const report = JSON.stringify(status);
    if (report === this.childReports.get(status.id)) return;
    this.terminal.setProgramStatus(status);
    this.childReports.set(status.id, report);
  }
}

function childBase(info: AgentBackgroundTaskInfo, previous?: ChildWork): ChildBase {
  return {
    id: previous?.id ?? recordId(info.taskId),
    taskId: info.taskId,
    agentId: info.agentId,
    title: info.subagentType === undefined ? 'Background agent' : `Background agent: ${info.subagentType}`,
  };
}

function isSettledChild(child: ChildWork): child is SettledChild {
  return child.status !== 'running';
}

function recordId(taskId: string): string {
  return `agent-${createHash('sha256').update(taskId).digest('hex').slice(0, 24)}`;
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split(/\r\n?|\n/, 1)[0]?.trim();
  return line === undefined || line.length === 0 ? undefined : line;
}

function isExplicitUserTurn(origin: TurnStartedEvent['origin'] | undefined): boolean {
  return (
    origin?.kind === 'user' ||
    origin?.kind === 'plugin_command' ||
    (origin?.kind === 'skill_activation' && origin.trigger === 'user-slash')
  );
}
