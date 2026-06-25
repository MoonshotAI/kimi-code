import { addUsage, type TokenUsage } from '@moonshot-ai/kosong';

import { registerSingleton, SyncDescriptor } from "#/_base/di";

import { IEventBus } from '../eventBus/eventBus';
import type { UsageRecordScope, UsageStatus } from './usage';
import { IUsageService } from './usage';
import { IWireRecord } from '../wireRecord/wireRecord';

declare module '../types' {
  interface WireRecordMap {
    'usage.record': {
      model: string;
      usage: TokenUsage;
      usageScope?: UsageRecordScope;
    };
  }
}

export class UsageService implements IUsageService {
  private readonly byModel: Record<string, TokenUsage> = {};
  private currentTurn: TokenUsage | undefined;

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
  ) {
    wireRecord.register('usage.record', (record) => {
      this.apply(record.model, record.usage, 'session');
    });
  }

  beginTurn(): void {
    this.currentTurn = undefined;
  }

  endTurn(): void {
    this.currentTurn = undefined;
  }

  record(model: string, usage: TokenUsage, scope: UsageRecordScope = 'session'): void {
    this.wireRecord.append({
      type: 'usage.record',
      model,
      usage,
      usageScope: scope,
    });
    this.apply(model, usage, scope);
    this.publishChanged();
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

  private apply(model: string, usage: TokenUsage, scope: UsageRecordScope): void {
    const current = this.byModel[model];
    this.byModel[model] = current === undefined ? copyUsage(usage) : addUsage(current, usage);

    if (scope === 'turn') {
      this.currentTurn =
        this.currentTurn === undefined ? copyUsage(usage) : addUsage(this.currentTurn, usage);
    }
  }

  private publishChanged(): void {
    const status = this.status();
    if (status === undefined) return;
    this.events.emit({ type: 'agent.status.updated', usage: status });
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

registerSingleton(IUsageService, new SyncDescriptor(UsageService, [], true));
