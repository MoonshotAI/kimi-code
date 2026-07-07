/**
 * `usage` domain (L3) — `IAgentUsageService` implementation.
 *
 * Accumulates the agent's token usage in the `wire` `UsageModel`, mutating it
 * only through the `usage.record` Op (`wire.dispatch(recordUsage(...))`) and
 * deriving `status()` snapshots from `wire.getModel`. The `agent.status.updated`
 * event is derived from the `usage.record` Op's `toEvent`. Bound at Agent scope.
 */

import { type TokenUsage } from '#/app/llmProtocol/usage';
import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { LLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { IAgentWireService, type IWireService } from '#/wire';
import type { UsageStatus } from './usage';
import { IAgentUsageService } from './usage';
import { recordUsage, UsageModel, usageStatusFromState, type UsageRecordScope } from './usageOps';

export class AgentUsageService extends Disposable implements IAgentUsageService {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentWireService private readonly wire: IWireService) {
    super();
  }

  record(model: string, usage: TokenUsage, source?: LLMRequestSource): void {
    const usageScope: UsageRecordScope = source?.type === 'turn' ? 'turn' : 'session';
    this.wire.dispatch(recordUsage({ model, usage, usageScope, context: source }));
  }

  status(): UsageStatus {
    return usageStatusFromState(this.wire.getModel(UsageModel));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUsageService,
  AgentUsageService,
  InstantiationType.Delayed,
  'usage',
);
