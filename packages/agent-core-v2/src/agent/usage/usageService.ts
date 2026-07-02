import {
  addUsage,
  type TokenUsage } from '@moonshot-ai/kosong';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Disposable } from '#/_base/di/lifecycle';

import { IAgentRecordService } from '#/agent/record';
import type { UsageRecordContext, UsageStatus } from './usage';
import { IAgentUsageService } from './usage';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'usage.record': {
      model: string;
      usage: TokenUsage;
      context?: UsageRecordContext;
    };
  }
}

export class AgentUsageService extends Disposable implements IAgentUsageService {
  declare readonly _serviceBrand: undefined;
  private readonly byModel: Record<string, TokenUsage> = {};
  private currentTurnId: number | undefined;
  private currentTurn: TokenUsage | undefined;

  constructor(@IAgentRecordService private readonly records: IAgentRecordService) {
    super();
    this._register(
      records.define('usage.record', {
        resume: (r) => {
          this.apply(r.model, r.usage, r.context);
        },
      }),
    );
  }

  record(model: string, usage: TokenUsage, context?: UsageRecordContext): void {
    this.records.append({
      type: 'usage.record',
      model,
      usage,
      context,
    });
    this.apply(model, usage, context);
    this.publishChanged();
  }

  status(): UsageStatus {
    const byModel = this.byModelSnapshot();
    const hasByModel = Object.keys(byModel).length > 0;
    const currentTurn = this.currentTurn;
    return {
      byModel: hasByModel ? byModel : undefined,
      total: hasByModel ? totalUsage(byModel) : undefined,
      currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
    };
  }

  private apply(model: string, usage: TokenUsage, context: UsageRecordContext | undefined): void {
    const current = this.byModel[model];
    this.byModel[model] = current === undefined ? copyUsage(usage) : addUsage(current, usage);

    if (context?.type === 'turn') {
      if (this.currentTurnId !== context.turnId) {
        this.currentTurnId = context.turnId;
        this.currentTurn = copyUsage(usage);
      } else {
        this.currentTurn =
          this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
      }
    }
  }

  private publishChanged(): void {
    const status = this.status();
    if (status === undefined) return;
    this.records.signal({ type: 'agent.status.updated', usage: status });
  }

  private byModelSnapshot(): Record<string, TokenUsage> {
    return Object.fromEntries(
      Object.entries(this.byModel).map(([model, usage]) => [model, copyUsage(usage)]),
    );
  }
}

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
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
