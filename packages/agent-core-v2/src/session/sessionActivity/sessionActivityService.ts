/**
 * `sessionActivity` domain (L6) — `ISessionActivityView` implementation.
 *
 * Folds every agent's activity projection — borrowed through the agent
 * handles from `agentLifecycle` (`IAgentActivityView.state()` seeded once at
 * attach, `agent.activity.updated` over each agent's `event` bus afterwards)
 * — together with the pending-interaction set from `interaction` into the
 * session-level aggregate, and fires `onDidChange` with the domain cause
 * only when the aggregate tuple actually changes. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentActivityView, type AgentActivityState } from '#/agent/activityView/activityView';
import type { TurnEndReason } from '#/agent/loop/turnEvents';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInteractionService, type Interaction } from '#/session/interaction/interaction';

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
  background: number;
  lastTurnReason?: SessionTurnOutcome;
}

export class SessionActivityView extends Disposable implements ISessionActivityView {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidChange = this._register(new Emitter<SessionActivityChangedEvent>());
  readonly onDidChange: Event<SessionActivityChangedEvent> = this._onDidChange.event;

  private readonly folds = new Map<string, AgentWorkFold>();
  private readonly agentSubscriptions = new Map<string, IDisposable>();
  private current: SessionActivityState;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionInteractionService private readonly interactions: ISessionInteractionService,
  ) {
    super();
    for (const handle of this.agents.list()) this.attachAgent(handle);
    this.current = this.aggregate();
    this._register(
      this.agents.onDidCreate((handle) => {
        this.attachAgent(handle);
        this.recompute('agent_lifecycle');
      }),
    );
    this._register(
      this.agents.onDidDispose((agentId) => {
        this.agentSubscriptions.get(agentId)?.dispose();
        this.agentSubscriptions.delete(agentId);
        if (this.folds.delete(agentId)) this.recompute('agent_lifecycle');
      }),
    );
    this._register(this.interactions.onDidChangePending(() => this.recompute('interaction')));
    this._register(
      toDisposable(() => {
        for (const subscription of this.agentSubscriptions.values()) subscription.dispose();
        this.agentSubscriptions.clear();
      }),
    );
  }

  state(): SessionActivityState {
    return this.current;
  }

  private attachAgent(handle: IAgentScopeHandle): void {
    if (this.folds.has(handle.id)) return;
    const view = handle.accessor.get(IAgentActivityView) as IAgentActivityView | undefined;
    this.folds.set(handle.id, foldOf(handle.id, view?.state()));
    const bus = handle.accessor.get(IEventBus) as IEventBus | undefined;
    if (bus === undefined) return;
    this.agentSubscriptions.set(
      handle.id,
      bus.subscribe('agent.activity.updated', (event) => this.onActivity(handle.id, event)),
    );
  }

  private onActivity(agentId: string, snapshot: AgentActivityState): void {
    const previous = this.folds.get(agentId);
    const next = foldOf(agentId, snapshot, previous);
    this.folds.set(agentId, next);
    if (previous === undefined) {
      this.recompute('agent_lifecycle');
      return;
    }
    let cause: SessionActivityCause | undefined;
    if (!previous.turnActive && next.turnActive) cause = 'turn_started';
    else if (previous.turnActive && !next.turnActive) cause = 'turn_ended';
    else if (previous.background !== next.background) cause = 'background';
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
      if (fold.turnActive || fold.background > 0) {
        busy = true;
        break;
      }
    }
    return {
      busy,
      mainTurnActive: this.folds.get(MAIN_AGENT_ID)?.turnActive ?? false,
      pendingInteraction: resolvePendingInteraction(this.interactions.listPending()),
      lastTurnReason: this.folds.get(MAIN_AGENT_ID)?.lastTurnReason,
    };
  }
}

function foldOf(
  agentId: string,
  activity: AgentActivityState | undefined,
  previous?: AgentWorkFold,
): AgentWorkFold {
  return {
    turnActive: activity?.turn !== undefined,
    background: activity?.background?.length ?? 0,
    lastTurnReason:
      agentId === MAIN_AGENT_ID ? mapTurnReason(activity?.lastTurn?.reason) : previous?.lastTurnReason,
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
  InstantiationType.Delayed,
  'sessionActivity',
);
