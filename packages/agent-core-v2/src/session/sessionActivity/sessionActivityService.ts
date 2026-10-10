import { Disposable, DisposableStore, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  registerScopedService,
  type IAgentScopeHandle,
} from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { defineState } from '#/state/state';
import { IEventBus } from '#/app/event/eventBus';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnStarted, type TurnEndReason } from '#/agent/loop/turnEvents';
import { TurnEnded, turnKey } from '#/agent/loop/turnOps';
import { IAgentTaskService } from '#/agent/task/task';
import { TaskStarted, TaskTerminatedNotice } from '#/agent/task/taskOps';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import {
  CompactionCancelled,
  CompactionCompleted,
  CompactionStarted,
} from '#/agent/fullCompaction/compactionOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { ToolCallStarted, ToolResultEvent } from '#/agent/toolExecutor/toolExecutorEvents';
import {
  NOTIFY_USER_DELIVERED_OUTPUT,
  NOTIFY_USER_TOOL_NAME,
} from '#/features/notify/tools/notify-user/notify-user';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { SubagentSpawned } from '#/session/subagent/mirrorAgentRun';
import {
  INTERACTION_TAG_SESSION_ID,
  type Interaction,
} from '#/human/interaction/interaction';
import { interactions } from '#/human/interaction/facade';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionStateService } from '#/session/state/sessionState';

import {
  ISessionActivityView,
  type SessionActivityCause,
  type SessionActivityChangedEvent,
  type SessionActivityState,
  type SessionLatestUpdate,
  type SessionPendingInteraction,
  type SessionTurnOutcome,
} from './sessionActivity';

interface AgentWorkFold {
  turnActive: boolean;
  background: ReadonlySet<string>;
  compacting: boolean;
  lastTurnReason?: SessionTurnOutcome;
}

export const sessionActivityFoldsKey = defineState<Map<string, AgentWorkFold>>(
  'sessionActivity.folds',
  () => new Map(),
);
export const sessionActivityCurrentKey = defineState<SessionActivityState>('sessionActivity.current', () => ({
  busy: false,
  mainTurnActive: false,
  pendingInteraction: 'none',
  lastTurnReason: undefined,
}));

export class SessionActivityView extends Disposable implements ISessionActivityView {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChange = this._register(new Emitter<SessionActivityChangedEvent>());
  readonly onDidChange: Event<SessionActivityChangedEvent> = this._onDidChange.event;

  private readonly agentSubscriptions = new Map<string, IDisposable>();
  private readonly pendingUpdates = new Map<string, { readonly agentId: string; readonly title: string }>();
  private readonly updateSources = new Map<string, string>();
  private latestUpdate: SessionLatestUpdate | undefined;

  constructor(
    @ISessionStateService private readonly states: ISessionStateService,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionContext private readonly ctx: ISessionContext,
  ) {
    super();
    this.states.contributeState(sessionActivityFoldsKey);
    this.states.contributeState(sessionActivityCurrentKey);
    for (const agent of this.agents.list()) {
      const handle = this.agents.handleOf(agent.agentId);
      if (handle !== undefined) this.attachAgent(handle);
    }
    this.current = this.aggregate();
    this._register(
      this.agents.onDidCreateScope(({ handle }) => {
        this.attachAgent(handle);
        this.recompute('agent_lifecycle');
      }),
    );
    this._register(
      this.agents.onDidClose((agent) => {
        this.agentSubscriptions.get(agent.agentId)?.dispose();
        this.agentSubscriptions.delete(agent.agentId);
        this.dropPendingUpdates(agent.agentId);
        this.updateSources.delete(agent.agentId);
        if (this.folds.delete(agent.agentId)) this.recompute('agent_lifecycle');
      }),
    );
    this._register(
      toDisposable(
        interactions.onDidChangePending(() => this.recompute('interaction')),
      ),
    );
    this._register(
      toDisposable(() => {
        for (const subscription of this.agentSubscriptions.values()) subscription.dispose();
        this.agentSubscriptions.clear();
      }),
    );
  }

  private get folds(): Map<string, AgentWorkFold> {
    return this.states.get(sessionActivityFoldsKey);
  }

  private get current(): SessionActivityState {
    return this.states.get(sessionActivityCurrentKey);
  }

  private set current(value: SessionActivityState) {
    this.states.set(sessionActivityCurrentKey, value);
  }

  state(): SessionActivityState {
    return this.current;
  }

  private attachAgent(handle: IAgentScopeHandle): void {
    if (this.folds.has(handle.id)) return;
    this.folds.set(handle.id, seedFold(handle));
    const bus = handle.accessor.get(IEventBus) as IEventBus | undefined;
    if (bus === undefined) return;
    const subscriptions = new DisposableStore();
    subscriptions.add(
      bus.subscribe(TurnStarted, () => {
        const clearsUpdate = handle.id === MAIN_AGENT_ID && this.latestUpdate !== undefined;
        if (clearsUpdate) this.latestUpdate = undefined;
        this.patchFold(handle.id, (fold) => ({
          ...fold,
          turnActive: true,
          lastTurnReason: handle.id === MAIN_AGENT_ID ? undefined : fold.lastTurnReason,
        }));
        if (clearsUpdate) this.recompute('turn_started');
      }),
    );
    subscriptions.add(
      bus.subscribe(TurnEnded, (event) => {
        this.dropPendingUpdates(handle.id);
        this.patchFold(handle.id, (fold) => ({
          ...fold,
          turnActive: false,
          lastTurnReason: handle.id === MAIN_AGENT_ID ? mapTurnReason(event.reason) : fold.lastTurnReason,
        }));
      }),
    );
    subscriptions.add(
      bus.subscribe(ToolCallStarted, (event) => {
        if (event.name !== NOTIFY_USER_TOOL_NAME) return;
        const title = updateTitleOf(event.args);
        if (title === undefined) return;
        this.pendingUpdates.set(updateKey(handle.id, event.toolCallId), { agentId: handle.id, title });
      }),
    );
    subscriptions.add(
      bus.subscribe(ToolResultEvent, (event) => {
        const key = updateKey(handle.id, event.toolCallId);
        const pending = this.pendingUpdates.get(key);
        if (pending === undefined) return;
        this.pendingUpdates.delete(key);
        if (event.isError === true || event.synthetic === true) return;
        if (event.output !== NOTIFY_USER_DELIVERED_OUTPUT) return;
        this.latestUpdate = {
          title: pending.title,
          agentId: handle.id,
          source: this.updateSources.get(handle.id),
          at: new Date().toISOString(),
        };
        this.recompute('update');
      }),
    );
    subscriptions.add(
      bus.subscribe(SubagentSpawned, (event) => {
        const description = event.description?.trim();
        if (description === undefined || description.length === 0) return;
        this.updateSources.set(event.subagentId, description);
      }),
    );
    subscriptions.add(
      bus.subscribe(TaskStarted, (event) =>
        this.patchFold(handle.id, (fold) => ({
          ...fold,
          background: new Set(fold.background).add(event.info.taskId),
        })),
      ),
    );
    subscriptions.add(
      bus.subscribe(TaskTerminatedNotice, (event) =>
        this.patchFold(handle.id, (fold) => {
          if (!fold.background.has(event.info.taskId)) return fold;
          const background = new Set(fold.background);
          background.delete(event.info.taskId);
          return { ...fold, background };
        }),
      ),
    );
    subscriptions.add(
      bus.subscribe(CompactionStarted, () =>
        this.patchFold(handle.id, (fold) => ({ ...fold, compacting: true })),
      ),
    );
    subscriptions.add(
      bus.subscribe(CompactionCompleted, () =>
        this.patchFold(handle.id, (fold) => ({ ...fold, compacting: false })),
      ),
    );
    subscriptions.add(
      bus.subscribe(CompactionCancelled, () =>
        this.patchFold(handle.id, (fold) => ({ ...fold, compacting: false })),
      ),
    );
    const dispatcher = handle.accessor.get(IEventDispatcher) as IEventDispatcher | undefined;
    if (dispatcher !== undefined) {
      subscriptions.add(
        dispatcher.hooks.onDidRestore.register('sessionActivity', async (_ctx, next) => {
          this.folds.set(handle.id, seedFold(handle));
          this.recompute('agent_lifecycle');
          await next();
        }),
      );
    }
    this.agentSubscriptions.set(handle.id, subscriptions);
  }

  private patchFold(agentId: string, patch: (fold: AgentWorkFold) => AgentWorkFold): void {
    const previous = this.folds.get(agentId);
    if (previous === undefined) return;
    const next = patch(previous);
    this.folds.set(agentId, next);
    let cause: SessionActivityCause | undefined;
    if (!previous.turnActive && next.turnActive) cause = 'turn_started';
    else if (previous.turnActive && !next.turnActive) cause = 'turn_ended';
    else if (previous.background.size !== next.background.size || previous.compacting !== next.compacting) {
      cause = 'background';
    }
    else if (agentId === MAIN_AGENT_ID && previous.lastTurnReason !== next.lastTurnReason) {
      cause = 'turn_ended';
    }
    if (cause !== undefined) this.recompute(cause);
  }

  private recompute(cause: SessionActivityCause): void {
    const next = this.aggregate();
    if (!next.busy) this.latestUpdate = undefined;
    if (activityEquals(this.current, next)) return;
    this.current = next;
    this._onDidChange.fire({ state: next, cause });
  }

  private dropPendingUpdates(agentId: string): void {
    for (const [key, pending] of this.pendingUpdates) {
      if (pending.agentId === agentId) this.pendingUpdates.delete(key);
    }
  }

  private aggregate(): SessionActivityState {
    let busy = false;
    for (const fold of this.folds.values()) {
      if (fold.turnActive || fold.background.size > 0 || fold.compacting) {
        busy = true;
        break;
      }
    }
    return {
      busy,
      mainTurnActive: this.folds.get(MAIN_AGENT_ID)?.turnActive ?? false,
      pendingInteraction: resolvePendingInteraction(
        interactions.findAll({
          resolved: false,
          tags: { [INTERACTION_TAG_SESSION_ID]: this.ctx.sessionId },
        }),
      ),
      lastTurnReason: this.folds.get(MAIN_AGENT_ID)?.lastTurnReason,
      latestUpdate: busy ? this.latestUpdate : undefined,
    };
  }
}

function seedFold(handle: IAgentScopeHandle): AgentWorkFold {
  const loop = handle.accessor.get(IAgentLoopService) as IAgentLoopService | undefined;
  const tasks = handle.accessor.get(IAgentTaskService) as IAgentTaskService | undefined;
  const compaction = handle.accessor.get(IAgentFullCompactionService) as
    | IAgentFullCompactionService
    | undefined;
  const states = handle.accessor.get(IAgentStateService) as IAgentStateService | undefined;
  const lastEnded =
    handle.id === MAIN_AGENT_ID && states?.has(turnKey) === true
      ? states.get(turnKey).lastEnded
      : undefined;
  return {
    turnActive: loop?.snapshot().state === 'running',
    background: new Set(tasks?.list(true).map((task) => task.taskId) ?? []),
    compacting: (compaction?.compacting ?? null) !== null,
    lastTurnReason:
      loop?.snapshot().state === 'running' ? undefined : mapTurnReason(lastEnded?.reason),
  };
}

function mapTurnReason(reason: TurnEndReason | undefined): SessionTurnOutcome | undefined {
  if (reason === undefined) return undefined;
  return reason === 'completed' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed';
}

function resolvePendingInteraction(pending: readonly Interaction[]): SessionPendingInteraction {
  if (pending.some((interaction) => interaction.kind === 'approval')) return 'approval';
  if (pending.some((interaction) => interaction.kind === 'question')) return 'question';
  return 'none';
}

function updateKey(agentId: string, toolCallId: string): string {
  return JSON.stringify([agentId, toolCallId]);
}

function updateTitleOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const title = (args as Record<string, unknown>)['title'];
  if (typeof title !== 'string') return undefined;
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function latestUpdateEquals(
  a: SessionLatestUpdate | undefined,
  b: SessionLatestUpdate | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.title === b.title && a.agentId === b.agentId && a.source === b.source && a.at === b.at;
}

function activityEquals(a: SessionActivityState, b: SessionActivityState): boolean {
  return (
    a.busy === b.busy &&
    a.mainTurnActive === b.mainTurnActive &&
    a.pendingInteraction === b.pendingInteraction &&
    a.lastTurnReason === b.lastTurnReason &&
    latestUpdateEquals(a.latestUpdate, b.latestUpdate)
  );
}

registerScopedService(
  LifecycleScope.Session,
  ISessionActivityView,
  SessionActivityView,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);
