import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { defineState } from '#/state/state';
import { AgentActivityUpdated } from '#/actor/activityView/activityViewEvents';
import type { AgentActivityState } from '#/actor/activityView/types';
import { AgentActivityView } from '#/actor/activityView/activityViewAgentRuntime';
import type { TurnEndReason } from '#/actor/loop/turnEvents';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentHostService } from '#/agent/host/agentHost';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import type { Interaction } from '#/actor/interaction/interaction';
import {
  listSessionPendingInteractions,
  onSessionInteractionDidChangePending,
} from '#/actor/interaction/sessionInteractions';
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
  background: number;
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
    @IAgentHostService private readonly hosts: IAgentHostService,
  ) {
    super();
    this.states.contributeState(sessionActivityFoldsKey);
    this.states.contributeState(sessionActivityCurrentKey);
    for (const agent of this.agents.list()) {
      this.attachAgent(agent);
    }
    this.current = this.aggregate();
    this._register(
      this.agents.onDidCreate((agent) => {
        this.attachAgent(agent);
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
      onSessionInteractionDidChangePending(this.agents, () => this.recompute('interaction')),
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

  private attachAgent(agent: AgentContext): void {
    if (this.folds.has(agent.agentId)) return;
    const bundle = this.hosts.of(agent);
    const activity = this.agents.resolve(agent, AgentActivityView).state();
    this.folds.set(agent.agentId, foldOf(agent.agentId, activity));
    this.agentSubscriptions.set(
      agent.agentId,
      bundle.eventBus.subscribe(AgentActivityUpdated, (event) => this.onActivity(agent.agentId, event)),
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
      pendingInteraction: resolvePendingInteraction(listSessionPendingInteractions(this.agents)),
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
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);
