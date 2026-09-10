import { modelKey, type LlmModel } from '#/llm/model';
import { emptyUsage, type TokenUsage } from '#/llm/usage';

export interface UsageRecord {
  usage: Partial<TokenUsage>;
  model?: LlmModel;
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
  return {
    total: addUsage(summary.total, record.usage),
    byModel:
      record.model === undefined
        ? summary.byModel
        : {
            ...summary.byModel,
            [modelKey(record.model)]: addUsage(
              summary.byModel[modelKey(record.model)],
              record.usage,
            ),
          },
    byTurn:
      record.turnId === undefined
        ? summary.byTurn
        : { ...summary.byTurn, [record.turnId]: addUsage(summary.byTurn[record.turnId], record.usage) },
  };
}
