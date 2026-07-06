/**
 * `usage` domain (L3) — `IAgentUsageService` implementation.
 *
 * Accumulates the agent's token usage in the `wire` `UsageModel`, mutating it
 * only through the `usage.record` Op (`wire.dispatch(recordUsage(...))`) and
 * deriving `status()` snapshots from `wire.getModel`. Publishes the resulting
 * `agent.status.updated` through `wire.signal` (edge reconnection of that
 * signal is a Phase 5 concern). Bound at Agent scope.
 */

import { addUsage, type TokenUsage } from '#/app/llmProtocol';
import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { LLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { IAgentWireService, type IWireService } from '#/wire';
import type { UsageStatus } from './usage';
import { IAgentUsageService } from './usage';
import { recordUsage, UsageModel } from './usageOps';

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
    const model = this.wire.getModel(UsageModel);
    const byModel = byModelSnapshot(model.byModel);
    const hasByModel = Object.keys(byModel).length > 0;
    const currentTurn = model.currentTurn;
    return {
      byModel: hasByModel ? byModel : undefined,
      total: hasByModel ? totalUsage(byModel) : undefined,
      currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
    };
  }

  private publishChanged(): void {
    this.wire.signal({ type: 'agent.status.updated', usage: this.status() });
  }
}

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

function byModelSnapshot(byModel: Record<string, TokenUsage>): Record<string, TokenUsage> {
  return Object.fromEntries(
    Object.entries(byModel).map(([model, usage]) => [model, copyUsage(usage)]),
  );
}

function totalUsage(byModel: Record<string, TokenUsage>): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const usage of Object.values(byModel)) {
    total = total === undefined ? copyUsage(usage) : addUsage(total, usage);
  }
  return total;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUsageService,
  AgentUsageService,
  InstantiationType.Delayed,
  'usage',
);
