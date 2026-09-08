import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IEventBus } from '#/app/event/eventBus';
import { AgentActivityUpdated } from '#/agent/activityView/activityView';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded, turnKey } from '#/agent/loop/turnOps';
import { ContextUndone } from '#/agent/undo/undoService';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import type { SessionTurnOutcome } from './sessionActivity';
import { ISessionOutcomeMirror } from './sessionOutcomeMirror';

export class SessionOutcomeMirror extends Disposable implements ISessionOutcomeMirror {
  declare readonly _serviceBrand: undefined;

  private lastPersisted: SessionTurnOutcome | undefined;
  private lastPersistedTurnId: number | undefined;
  private adopted = false;
  private turnStartedHere = false;
  private mainSubscription: DisposableStore | undefined;
  private readonly metadataReady: Promise<void>;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    this.metadataReady = this.metadata
      .read()
      .then((meta) => {
        if (!this.adopted) this.lastPersisted = meta.lastTurnReason;
      })
      .catch(() => {});
    this.attachMain();
    this._register(this.agents.onDidCreate((agent) => {
      if (agent.agentId === MAIN_AGENT_ID) this.attachMain();
    }));
    this._register(this.agents.onDidClose((agent) => {
      if (agent.agentId !== MAIN_AGENT_ID) return;
      this.mainSubscription?.dispose();
      this.mainSubscription = undefined;
    }));
    this._register({
      dispose: () => {
        this.mainSubscription?.dispose();
        this.mainSubscription = undefined;
      },
    });
  }

  private attachMain(): void {
    if (this.mainSubscription !== undefined) return;
    const handle = this.agents.handleOf(MAIN_AGENT_ID);
    const bus = handle?.accessor.get(IEventBus) as IEventBus | undefined;
    if (bus === undefined) return;
    const subscription = new DisposableStore();
    this.mainSubscription = subscription;
    const dispatcher = handle?.accessor.get(IEventDispatcher) as IEventDispatcher | undefined;
    const agentStates = handle?.accessor.get(IAgentStateService) as IAgentStateService | undefined;
    if (dispatcher !== undefined && agentStates !== undefined) {
      subscription.add(
        dispatcher.hooks.onDidRestore.register('session-outcome-mirror', async (_ctx, next) => {
          await next();
          await this.reconcileAfterRestore(agentStates);
        }),
      );
    }
    subscription.add(
      bus.subscribe(TurnEnded, (event) => {
        if (event.reason === 'completed') {
          this.write('completed', { turnId: event.turnId });
          return;
        }
        if (event.reason === 'failed' || event.reason === 'blocked') {
          this.write('failed', { turnId: event.turnId });
          return;
        }
        if (event.reason === 'cancelled' && event.interruptReason === 'user_cancelled') {
          this.write('cancelled', { turnId: event.turnId });
        }
      }),
    );
    subscription.add(
      bus.subscribe(TurnStarted, () => {
        this.turnStartedHere = true;
        this.write(undefined);
      }),
    );
    subscription.add(
      bus.subscribe(ContextUndone, (event) => {
        if (
          event.fromTurnId !== undefined &&
          this.lastPersistedTurnId !== undefined &&
          this.lastPersistedTurnId < event.fromTurnId
        ) {
          return;
        }
        this.write(undefined);
      }),
    );
    subscription.add(
      bus.subscribe(AgentActivityUpdated, (event) => {
        if (this.turnStartedHere) return;
        if (this.lastPersisted !== undefined) return;
        const reason = event.lastTurn?.reason;
        if (reason === 'completed' || reason === 'cancelled') {
          this.write(reason, { touchUpdatedAt: false, turnId: event.lastTurn?.turnId });
        } else if (reason === 'failed' || reason === 'blocked') {
          this.write('failed', { touchUpdatedAt: false, turnId: event.lastTurn?.turnId });
        }
      }),
    );
  }

  private async reconcileAfterRestore(agentStates: IAgentStateService): Promise<void> {
    await this.metadataReady;
    if (this.lastPersisted === undefined) return;
    if (this.turnStartedHere) return;
    if (!agentStates.has(turnKey)) return;
    const lastEnded = agentStates.get(turnKey).lastEnded;
    if (lastEnded === undefined) {
      this.write(undefined, { touchUpdatedAt: false });
      return;
    }
    if (this.lastPersistedTurnId === undefined) this.lastPersistedTurnId = lastEnded.turnId;
  }

  private write(
    outcome: SessionTurnOutcome | undefined,
    opts?: { readonly touchUpdatedAt?: boolean; readonly turnId?: number },
  ): void {
    if (outcome === this.lastPersisted) {
      if (opts?.turnId !== undefined) this.lastPersistedTurnId = opts.turnId;
      return;
    }
    this.adopted = true;
    const previous = this.lastPersisted;
    const previousTurnId = this.lastPersistedTurnId;
    this.lastPersisted = outcome;
    this.lastPersistedTurnId =
      outcome === undefined ? undefined : (opts?.turnId ?? this.lastPersistedTurnId);
    void this.metadata
      .update({ lastTurnReason: outcome }, { touchUpdatedAt: opts?.touchUpdatedAt })
      .catch(() => {
        if (this.lastPersisted === outcome) {
          this.lastPersisted = previous;
          this.lastPersistedTurnId = previousTurnId;
        }
      });
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionOutcomeMirror,
  SessionOutcomeMirror,
  ScopeActivation.OnScopeCreated,
  'sessionActivity',
);
