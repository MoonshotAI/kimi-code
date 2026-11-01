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
  readonly appState: Pick<AppState, 'isCompacting' | 'sessionTitle' | 'streamingPhase'>;
  readonly queuedMessages: readonly unknown[];
  readonly queuedMessageDispatchPending: boolean;
}

interface ProgramStatusBlocked {
  readonly kind: 'permission' | 'question' | 'auth';
  readonly message: string;
}

export interface ProgramStatusInteraction {
  readonly agentId?: string;
  readonly kind: 'permission' | 'question';
  readonly message?: string;
}

export interface ProgramStatusInteractionTracker {
  startInteraction(interaction: ProgramStatusInteraction): symbol;
  endInteraction(token: symbol): void;
}

export interface ProgramStatusSubagentStart {
  readonly agentId: string;
  readonly title: string;
  readonly taskId?: string;
}

type WorkOutcome =
  | { readonly state: 'idle' }
  | { readonly state: 'done' }
  | { readonly state: 'error'; readonly message: string };

interface ChildBase {
  readonly id: string;
  readonly agentId: string;
  readonly taskId?: string;
  readonly title: string;
  readonly lastActive: number;
}

type ChildWork = ChildBase &
  (
    | { readonly status: 'working' }
    | { readonly status: 'done' }
    | { readonly status: 'error'; readonly message: string }
  );

type TrackedInteraction = ProgramStatusInteraction & { readonly order: number };

export class ProgramStatusController implements ProgramStatusInteractionTracker {
  private readonly children = new Map<string, ChildWork>();
  private readonly interactions = new Map<symbol, TrackedInteraction>();
  private readonly childReports = new Map<string, string>();
  private rootReport: string | undefined;
  private outcome: WorkOutcome = { state: 'idle' };
  private readonly authBlocks = new Set<symbol>();
  private authRequired = false;
  private activityOrder = 0;
  private interactionOrder = 0;
  private clearSettledOnTurnEnd = false;

  constructor(
    private readonly state: ProgramStatusState,
    private readonly terminal: ProgramStatusTerminal,
    private readonly childrenEnabled = allowsChildRecords(),
  ) {}

  refresh(): void {
    this.publishRoot(this.rootStatus());
    const selected = this.childrenEnabled
      ? [...this.children.values()]
          .toSorted(
            (leftChild, rightChild) =>
              childRank(leftChild, this.interactionFor(leftChild.agentId) !== undefined) -
                childRank(rightChild, this.interactionFor(rightChild.agentId) !== undefined) ||
              rightChild.lastActive - leftChild.lastActive,
          )
          .slice(0, MAX_CHILD_RECORDS)
      : [];
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
    this.authBlocks.clear();
    this.clearSettledOnTurnEnd = false;
    this.publishRoot(this.rootStatus());
  }

  beginTurn(origin: TurnStartedEvent['origin'] | undefined): void {
    if (origin !== undefined && clearsSettledChildren(origin)) {
      this.clearSettledOnTurnEnd = true;
    }
  }

  markUserSteer(): void {
    this.clearSettledOnTurnEnd = true;
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
    if (this.clearSettledOnTurnEnd) {
      this.clearSettledChildren();
      this.clearSettledOnTurnEnd = false;
    }
    this.refresh();
  }

  finishCompaction(): void {
    this.outcome = { state: 'idle' };
    this.refresh();
  }

  finishShell(): void {
    this.outcome = { state: 'idle' };
    this.refresh();
  }

  acknowledgeResults(): void {
    this.outcome = { state: 'idle' };
    this.clearSettledChildren();
    this.refresh();
  }

  failRequest(message: string): void {
    this.outcome = { state: 'error', message: firstLine(message) ?? 'Request failed' };
    this.refresh();
  }

  startSubagent(input: ProgramStatusSubagentStart): void {
    const previous = this.children.get(input.agentId);
    this.children.set(input.agentId, {
      id: previous?.id ?? recordId(input.agentId),
      agentId: input.agentId,
      taskId: input.taskId ?? previous?.taskId,
      title: nonEmpty(input.title) ?? previous?.title ?? input.agentId,
      status: 'working',
      lastActive: ++this.activityOrder,
    });
    this.refresh();
  }

  completeSubagent(agentId: string): void {
    this.settleSubagent(agentId, 'done');
  }

  failSubagent(agentId: string, message: string): void {
    this.settleSubagent(agentId, 'error', undefined, firstLine(message) ?? 'Subagent failed');
  }

  cancelSubagent(agentId: string): void {
    this.children.delete(agentId);
    this.removeAgentInteractions(agentId);
    this.refresh();
  }

  touchSubagent(agentId: string): void {
    const previous = this.children.get(agentId);
    if (previous === undefined) return;
    this.children.set(agentId, { ...previous, lastActive: ++this.activityOrder });
    this.refresh();
  }

  updateBackgroundTask(info: BackgroundTaskInfo): void {
    if (info.kind !== 'agent' || info.agentId === undefined) return;
    const { agentId } = info;
    const previous = this.children.get(agentId);
    const base = childBase(info, agentId, previous);
    if (info.status !== 'running') this.removeAgentInteractions(agentId);
    switch (info.status) {
      case 'running':
        if (
          previous !== undefined &&
          previous.status !== 'working' &&
          (previous.taskId === undefined || previous.taskId === info.taskId)
        ) {
          return;
        }
        this.children.set(agentId, {
          ...base,
          status: 'working',
          lastActive: ++this.activityOrder,
        });
        break;
      case 'completed':
        this.settleSubagent(agentId, 'done', base);
        return;
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
        this.settleSubagent(agentId, 'error', base, message);
        return;
      }
      case 'killed':
        this.children.delete(agentId);
        break;
    }
    this.refresh();
  }

  restoreBackgroundTasks(tasks: readonly BackgroundTaskInfo[]): void {
    this.children.clear();
    this.interactions.clear();
    for (const info of tasks) {
      if (info.kind !== 'agent' || info.agentId === undefined || info.status !== 'running') continue;
      this.children.set(info.agentId, {
        ...childBase(info, info.agentId),
        status: 'working',
        lastActive: ++this.activityOrder,
      });
    }
    this.refresh();
  }

  startInteraction(interaction: ProgramStatusInteraction): symbol {
    const token = Symbol(interaction.kind);
    this.interactions.set(token, {
      ...interaction,
      message: interaction.message ?? defaultInteractionMessage(interaction.kind),
      order: ++this.interactionOrder,
    });
    this.refresh();
    return token;
  }

  endInteraction(token: symbol): void {
    if (!this.interactions.delete(token)) return;
    this.refresh();
  }

  setAuthRequired(required: boolean): void {
    if (this.authRequired === required) return;
    this.authRequired = required;
    this.refresh();
  }

  beginAuthBlock(): () => void {
    const token = Symbol();
    this.authBlocks.add(token);
    this.refresh();
    return () => {
      if (!this.authBlocks.delete(token)) return;
      this.refresh();
    };
  }

  private rootStatus(): ProgramStatus {
    if (this.authRequired || this.authBlocks.size > 0) {
      return { state: 'blocked', app: 'kimi-code', ...AUTH_BLOCKED };
    }
    const blocked =
      this.interactionOfKind('permission') ?? this.interactionOfKind('question');
    if (blocked !== undefined) {
      return {
        state: 'blocked',
        app: 'kimi-code',
        kind: blocked.kind,
        message: blocked.message,
      };
    }
    if (this.hasMainWork()) {
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
    if (child.status === 'working') {
      const interaction = this.interactionFor(child.agentId);
      if (interaction !== undefined) {
        return {
          state: 'blocked',
          id: child.id,
          title: child.title,
          kind: interaction.kind,
          message: interaction.message,
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

  private hasMainWork(): boolean {
    const { appState } = this.state;
    if (appState.isCompacting || appState.streamingPhase !== 'idle') return true;
    return this.state.queuedMessages.length > 0 || this.state.queuedMessageDispatchPending;
  }

  private sessionLabel(): string {
    const title = this.state.appState.sessionTitle?.trim();
    return title === undefined || title.length === 0 ? PRODUCT_NAME : title;
  }

  private interactionOfKind(
    kind: 'permission' | 'question',
  ): TrackedInteraction | undefined {
    let selected: TrackedInteraction | undefined;
    for (const interaction of this.interactions.values()) {
      if (interaction.kind !== kind) continue;
      if (selected === undefined || interaction.order < selected.order) selected = interaction;
    }
    return selected;
  }

  private interactionFor(agentId: string): TrackedInteraction | undefined {
    let selected: TrackedInteraction | undefined;
    for (const interaction of this.interactions.values()) {
      if (interaction.agentId !== agentId) continue;
      if (selected === undefined || interaction.order < selected.order) selected = interaction;
    }
    return selected;
  }

  private removeAgentInteractions(agentId: string): void {
    for (const [token, interaction] of this.interactions) {
      if (interaction.agentId === agentId) this.interactions.delete(token);
    }
  }

  private settleSubagent(
    agentId: string,
    status: 'done' | 'error',
    base?: ChildBase,
    message?: string,
  ): void {
    const previous = this.children.get(agentId);
    const current = base ?? previous ?? childIdentity(agentId);
    const unchanged =
      previous?.status === status &&
      (status === 'done' || (previous.status === 'error' && previous.message === message));
    const lastActive = unchanged ? current.lastActive : ++this.activityOrder;
    if (status === 'done') {
      this.children.set(agentId, { ...current, status, lastActive });
    } else {
      this.children.set(agentId, {
        ...current,
        status,
        message: message ?? 'Subagent failed',
        lastActive,
      });
    }
    this.removeAgentInteractions(agentId);
    this.refresh();
  }

  private clearSettledChildren(): void {
    for (const [agentId, child] of this.children) {
      if (child.status !== 'working') this.children.delete(agentId);
    }
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

function childBase(
  info: AgentBackgroundTaskInfo,
  agentId: string,
  previous?: ChildWork,
): ChildBase {
  return {
    id: previous?.id ?? recordId(agentId),
    agentId,
    taskId: info.taskId,
    title:
      nonEmpty(info.description) ??
      previous?.title ??
      nonEmpty(info.subagentType) ??
      'Subagent',
    lastActive: previous?.lastActive ?? 0,
  };
}

function childIdentity(agentId: string): ChildBase {
  return {
    id: recordId(agentId),
    agentId,
    title: agentId,
    lastActive: 0,
  };
}

function childRank(child: ChildWork, blocked: boolean): number {
  if (blocked && child.status === 'working') return 0;
  if (child.status === 'error') return 1;
  if (child.status === 'working') return 2;
  return 3;
}

function defaultInteractionMessage(kind: 'permission' | 'question'): string {
  return kind === 'permission' ? 'Approval required' : 'Answer required';
}

function recordId(agentId: string): string {
  return `agent-${createHash('sha256').update(agentId).digest('hex').slice(0, 24)}`;
}

function nonEmpty(text: string | undefined): string | undefined {
  const value = text?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function firstLine(text: string | undefined): string | undefined {
  return nonEmpty(text?.split(/\r\n?|\n/, 1)[0]);
}

function clearsSettledChildren(origin: NonNullable<TurnStartedEvent['origin']>): boolean {
  return (
    origin.kind === 'user' ||
    origin.kind === 'plugin_command' ||
    origin.kind === 'cron_job' ||
    origin.kind === 'cron_missed' ||
    (origin.kind === 'skill_activation' && origin.trigger === 'user-slash')
  );
}

function allowsChildRecords(): boolean {
  return (
    process.env['TMUX'] === undefined &&
    process.env['STY'] === undefined &&
    process.env['ZELLIJ'] === undefined &&
    process.env['ZELLIJ_SESSION_NAME'] === undefined &&
    process.env['HERDR_ENV'] === undefined
  );
}
