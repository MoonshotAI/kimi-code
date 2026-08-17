/**
 * `usage` domain — `IAgentUsageService` implementation.
 *
 * Accumulates the agent's token usage in the `usageKey` state, mutating it
 * only through the durable `UsageRecord` event
 * (`dispatcher.dispatch(new UsageRecord(...))`) and deriving `status()`
 * snapshots from `dispatcher.getState`. The per-turn accumulator
 * (`currentTurnId` / `currentTurn`) is live-only service state — it is not
 * persisted and resets on resume, matching v1 — and is registered into
 * `agentState` (`IAgentStateService`) and read/written through it. The usage
 * slice of `agent.status.updated` is dispatched here after each live record
 * (replay stays silent, like v1's restore), and the `onDidRecord` event
 * notifies agent-scoped consumers of the live record. Bound at Agent scope.
 */

import { addUsage, type TokenUsage } from '#/kosong/contract/usage';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { defineState } from '#/state/state';

import type { AgentLLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import type { UsageRecordedContext, UsageStatus } from './usage';
import { IAgentUsageService } from './usage';
import { AgentStatusUpdated } from './usageEvents';
import {
  copyUsage,
  usageKey,
  UsageRecord,
  usageStatusFromState,
  type UsageRecordScope,
} from './usageOps';

export const usageCurrentTurnIdKey = defineState<number | undefined>(
  'usage.currentTurnId',
  () => undefined as number | undefined,
);
export const usageCurrentTurnKey = defineState<TokenUsage | undefined>(
  'usage.currentTurn',
  () => undefined as TokenUsage | undefined,
);

export class AgentUsageService extends Service implements IAgentUsageService {
  declare readonly _serviceBrand: undefined;

  private readonly _onDidRecord = this._register(new Emitter<UsageRecordedContext>());
  readonly onDidRecord: Event<UsageRecordedContext> = this._onDidRecord.event;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(usageKey);
    this.states.contributeState(usageCurrentTurnIdKey);
    this.states.contributeState(usageCurrentTurnKey);
  }

  private get currentTurnId(): number | undefined {
    return this.states.get(usageCurrentTurnIdKey);
  }

  private set currentTurnId(value: number | undefined) {
    this.states.set(usageCurrentTurnIdKey, value);
  }

  private get currentTurn(): TokenUsage | undefined {
    return this.states.get(usageCurrentTurnKey);
  }

  private set currentTurn(value: TokenUsage | undefined) {
    this.states.set(usageCurrentTurnKey, value);
  }

  record(model: string, usage: TokenUsage, source?: AgentLLMRequestSource): void {
    const usageScope: UsageRecordScope = source?.type === 'turn' ? 'turn' : 'session';
    void this.dispatcher.dispatch(new UsageRecord({ model, usage, usageScope }));

    const turnId = source?.type === 'turn' ? source.turnId : undefined;
    if (turnId !== undefined) {
      if (this.currentTurnId !== turnId) {
        this.currentTurnId = turnId;
        this.currentTurn = copyUsage(usage);
      } else {
        this.currentTurn =
          this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
      }
    }

    void this.dispatcher.dispatch(new AgentStatusUpdated({ usage: this.status() }));
    this._onDidRecord.fire({ model, usage: copyUsage(usage), source });
  }

  status(): UsageStatus {
    return usageStatusFromState(this.states.get(usageKey), this.currentTurn);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUsageService,
  AgentUsageService,
  ScopeActivation.OnScopeCreated,
  'usage',
);
