import type { UsageStatus } from '#/rpc';
import { addUsage, type TokenUsage } from '@moonshot-ai/kosong';

import type { Agent } from '..';

export type UsageRecordScope = 'session' | 'turn';

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

export class UsageRecorder {
  private readonly byModel: Record<string, TokenUsage> = {};
  private currentTurn: TokenUsage | undefined;

  constructor(protected readonly agent?: Agent) {}

  beginTurn(): void {
    this.currentTurn = undefined;
  }

  endTurn(): void {
    this.currentTurn = undefined;
  }

  record(model: string, usage: TokenUsage, scope: UsageRecordScope = 'session'): void {
    this.agent?.records.logRecord({
      type: 'usage.record',
      model,
      usage,
      usageScope: scope,
    });
    const current = this.byModel[model];
    this.byModel[model] = current === undefined ? copyUsage(usage) : addUsage(current, usage);

    if (scope === 'turn') {
      this.currentTurn =
        this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
    }
    this.agent?.emitStatusUpdated();
  }

  data(): UsageStatus {
    const byModel = this.byModelSnapshot();
    const hasByModel = Object.keys(byModel).length > 0;
    const currentTurn = this.currentTurn;
    return {
      byModel: hasByModel ? byModel : undefined,
      total: hasByModel ? totalUsage(byModel) : undefined,
      currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
    };
  }

  status(): UsageStatus | undefined {
    const status = this.data();
    if (
      status.byModel === undefined &&
      status.total === undefined &&
      status.currentTurn === undefined
    ) {
      return undefined;
    }
    return status;
  }

  private byModelSnapshot(): Record<string, TokenUsage> {
    return Object.fromEntries(
      Object.entries(this.byModel).map(([model, usage]) => [model, copyUsage(usage)]),
    );
  }
}

function totalUsage(byModel: Record<string, TokenUsage>): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const usage of Object.values(byModel)) {
    total = total === undefined ? copyUsage(usage) : addUsage(total, usage);
  }
  return total;
}
