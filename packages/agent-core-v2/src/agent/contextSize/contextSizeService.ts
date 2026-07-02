import {
  Disposable,
} from "#/_base/di";
import {
  estimateTokensForMessage,
} from "#/_base/utils/tokens";
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentRecordService, type AgentRecord } from '#/agent/record';
import {
  IAgentContextSizeService,
  type ContextSizeStatus,
} from './contextSize';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'context_size.measured': {
      length: number;
      tokens: number;
    };
  }
}

export class AgentContextSizeService
  extends Disposable
  implements IAgentContextSizeService
{
  declare readonly _serviceBrand: undefined;

  private estimates: number[] = [];
  private measuredPrefixTokens: Array<number | null> = [0];
  private lastEmitted: ContextSizeStatus = {
    contextTokens: 0,
    contextTokensWithPending: 0,
  };

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentRecordService private readonly records: IAgentRecordService,
  ) {
    super();
    this._register(
      this.context.hooks.onSpliced.register('context-size', async (ctx, next) => {
        this.applySplice(ctx);
        await next();
      }),
    );
    this._register(
      records.define('context_size.measured', {
        resume: (r) => {
          this.applyMeasurement(r);
        },
      }),
    );
  }

  getStatus(): ContextSizeStatus {
    const measured = this.lastMeasuredPrefix();
    const pendingTokens = sum(this.estimates.slice(measured.length));
    return {
      contextTokens: measured.tokens,
      contextTokensWithPending: measured.tokens + pendingTokens,
    };
  }

  measured(length: number, tokens: number): void {
    const record: AgentRecord<'context_size.measured'> = {
      type: 'context_size.measured',
      length,
      tokens,
    };
    this.records.append(record);
    this.applyMeasurement(record);
  }

  private applySplice(context: {
    readonly start: number;
    readonly deleteCount: number;
    readonly messages: readonly ContextMessage[];
    readonly tokens?: number;
  }): void {
    const start = normalizeSpliceStart(context.start, this.estimates.length);
    const deleteCount = clampDeleteCount(context.deleteCount, this.estimates.length - start);
    const inserted = context.messages.map((message) => estimateTokensForMessage(message));
    this.estimates.splice(start, deleteCount, ...inserted);

    const previous = this.measuredPrefixTokens;
    const next = Array.from({ length: this.estimates.length + 1 }, () => null as number | null);
    const copied = Math.min(start, previous.length - 1);
    for (let index = 0; index <= copied; index++) {
      next[index] = previous[index] ?? null;
    }
    next[0] = 0;

    if (context.tokens !== undefined) {
      next[this.estimates.length] = Math.max(0, context.tokens);
    }

    this.measuredPrefixTokens = next;
    this.emitIfChanged();
  }

  private applyMeasurement(record: AgentRecord<'context_size.measured'>): void {
    const length = clampMeasuredLength(record.length, this.estimates.length);
    const tokens = Math.max(0, record.tokens);
    this.measuredPrefixTokens[length] = tokens;
    this.emitIfChanged();
  }

  private lastMeasuredPrefix(): { readonly length: number; readonly tokens: number } {
    for (let index = this.measuredPrefixTokens.length - 1; index >= 0; index--) {
      const tokens = this.measuredPrefixTokens[index];
      if (tokens !== null && tokens !== undefined) {
        return { length: index, tokens };
      }
    }
    return { length: 0, tokens: 0 };
  }

  private emitIfChanged(): void {
    const status = this.getStatus();
    if (status.contextTokens === this.lastEmitted.contextTokens) {
      return;
    }
    this.lastEmitted = status;
    this.records.signal({
      type: 'agent.status.updated',
      contextTokens: status.contextTokens,
    });
  }
}

function normalizeSpliceStart(start: number, length: number): number {
  if (start < 0) return Math.max(0, length + start);
  return Math.min(start, length);
}

function clampDeleteCount(deleteCount: number, max: number): number {
  if (!Number.isFinite(deleteCount) || deleteCount <= 0) return 0;
  return Math.min(deleteCount, Math.max(0, max));
}

function clampMeasuredLength(length: number, max: number): number {
  if (!Number.isFinite(length)) return max;
  return Math.min(Math.max(0, Math.floor(length)), max);
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextSizeService,
  AgentContextSizeService,
  InstantiationType.Delayed,
  'contextSize',
);
