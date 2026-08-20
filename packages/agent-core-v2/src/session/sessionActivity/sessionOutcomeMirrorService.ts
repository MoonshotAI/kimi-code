import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IEventBus } from '#/app/event/eventBus';
import { AgentActivityUpdated } from '#/agent/activityView/activityView';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
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
  private adopted = false;
  private turnStartedHere = false;
  private mainSubscription: DisposableStore | undefined;

  constructor(
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    void this.metadata
      .read()
      .then((meta) => {
        if (!this.adopted) this.lastPersisted = meta.lastTurnReason;
      })
      .catch(() => {});
    this.attachMain();
    this._register(this.agents.onDidCreate((agent) => {
      if (agent.agentId === MAIN_AGENT_ID) this.attachMain();
    }));
    this._register(this.agents.onDidDispose((agent) => {
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
    const bus = this.agents.findAgentHandle(MAIN_AGENT_ID)?.accessor.get(IEventBus) as
      | IEventBus
      | undefined;
    if (bus === undefined) return;
    const subscription = new DisposableStore();
    this.mainSubscription = subscription;
    subscription.add(
      bus.subscribe(TurnEnded, (event) => {
        if (event.reason === 'completed') {
          this.write('completed');
          return;
        }
        if (event.reason === 'failed' || event.reason === 'blocked') {
          this.write('failed');
          return;
        }
        if (event.reason === 'cancelled' && event.interruptReason === 'user_cancelled') {
          this.write('cancelled');
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
      bus.subscribe(AgentActivityUpdated, (event) => {
        if (this.turnStartedHere) return;
        if (this.lastPersisted !== undefined) return;
        const reason = event.lastTurn?.reason;
        if (reason === 'completed' || reason === 'cancelled') {
          this.write(reason, { touchUpdatedAt: false });
        } else if (reason === 'failed' || reason === 'blocked') {
          this.write('failed', { touchUpdatedAt: false });
        }
      }),
    );
  }

  private write(
    outcome: SessionTurnOutcome | undefined,
    opts?: { readonly touchUpdatedAt?: boolean },
  ): void {
    if (outcome === this.lastPersisted) return;
    this.adopted = true;
    const previous = this.lastPersisted;
    this.lastPersisted = outcome;
    void this.metadata.update({ lastTurnReason: outcome }, opts).catch(() => {
      if (this.lastPersisted === outcome) this.lastPersisted = previous;
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
