/**
 * `usage` domain (L3) — `IAgentUsageService` implementation.
 *
 * Accumulates the agent's token usage in the `wire` `UsageModel`, mutating it
 * only through the `usage.record` Op (`wire.dispatch(recordUsage(...))`) and
 * deriving `status()` snapshots from `wire.getModel`. Publishes the resulting
 * `agent.status.updated` through `wire.signal` (edge reconnection of that
 * signal is a Phase 5 concern). Bound at Agent scope.
 */

import { type TokenUsage } from '#/app/llmProtocol';
import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { LLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { IAgentWireService, type IWireService } from '#/wire';
import type { UsageStatus } from './usage';
import { IAgentUsageService } from './usage';
import { recordUsage, UsageModel, usageStatusFromState } from './usageOps';

export class AgentUsageService extends Disposable implements IAgentUsageService {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentWireService private readonly wire: IWireService) {
    super();
  }

  record(model: string, usage: TokenUsage, source?: LLMRequestSource): void {
    this.wire.dispatch(recordUsage({ model, usage, context: source }));
    this.publishChanged();
  }

  status(): UsageStatus {
    return usageStatusFromState(this.wire.getModel(UsageModel));
  }

  private publishChanged(): void {
    this.wire.signal({ type: 'agent.status.updated', usage: this.status() });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUsageService,
  AgentUsageService,
  InstantiationType.Delayed,
  'usage',
);
