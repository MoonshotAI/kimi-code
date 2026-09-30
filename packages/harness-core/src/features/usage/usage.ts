import { emptyUsage, type LlmModelSpec, type TokenUsage } from '@moonshot-ai/agent-core';

export interface UsageRecord {
  usage: Partial<TokenUsage>;
  model?: LlmModelSpec;
  turnId?: number;
  at: number;
}

export interface UsageSummary {
  total: TokenUsage;
  byModel: Record<string, TokenUsage>;
  byTurn: Record<number, TokenUsage>;
}

export function emptyUsageSummary(): UsageSummary {
  return { total: emptyUsage(), byModel: {}, byTurn: {} };
}

function addUsage(base: TokenUsage | undefined, usage: Partial<TokenUsage>): TokenUsage {
  const next = base ?? emptyUsage();
  return {
    inputOther: next.inputOther + (usage.inputOther ?? 0),
    output: next.output + (usage.output ?? 0),
    inputCacheRead: next.inputCacheRead + (usage.inputCacheRead ?? 0),
    inputCacheCreation: next.inputCacheCreation + (usage.inputCacheCreation ?? 0),
  };
}

export function accumulateUsage(summary: UsageSummary, record: UsageRecord): UsageSummary {
  const key = record.model === undefined ? undefined : `${record.model.provider}/${record.model.name}`;
  return {
    total: addUsage(summary.total, record.usage),
    byModel:
      key === undefined
        ? summary.byModel
        : {
            ...summary.byModel,
            [key]: addUsage(summary.byModel[key], record.usage),
          },
    byTurn:
      record.turnId === undefined
        ? summary.byTurn
        : { ...summary.byTurn, [record.turnId]: addUsage(summary.byTurn[record.turnId], record.usage) },
  };
}
