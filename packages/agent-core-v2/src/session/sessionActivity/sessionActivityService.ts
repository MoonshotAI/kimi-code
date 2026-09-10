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
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
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
      bus.subscribe(TurnStarted, () =>
        this.patchFold(handle.id, (fold) => ({
          ...fold,
          turnActive: true,
          lastTurnReason: handle.id === MAIN_AGENT_ID ? undefined : fold.lastTurnReason,
        })),
      ),
    );
    subscriptions.add(
      bus.subscribe(TurnEnded, (event) =>
        this.patchFold(handle.id, (fold) => ({
          ...fold,
          turnActive: false,
          lastTurnReason: handle.id === MAIN_AGENT_ID ? mapTurnReason(event.reason) : fold.lastTurnReason,
        })),
      ),
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
    if (activityEquals(this.current, next)) return;
    this.current = next;
    this._onDidChange.fire({ state: next, cause });
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
    turnActive: loop?.status().state === 'running',
    background: new Set(tasks?.list(true).map((task) => task.taskId) ?? []),
    compacting: (compaction?.compacting ?? null) !== null,
    lastTurnReason:
      loop?.status().state === 'running' ? undefined : mapTurnReason(lastEnded?.reason),
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

function activityEquals(a: SessionActivityState, b: SessionActivityState): boolean {
  return (
    a.busy === b.busy &&
    a.mainTurnActive === b.mainTurnActive &&
    a.pendingInteraction === b.pendingInteraction &&
    a.lastTurnReason === b.lastTurnReason
  );
}

registerScopedService(
  LifecycleScope.Session,
  ISessionActivityView,
  SessionActivityView,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);
