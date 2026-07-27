/**
 * `usage` domain (L3) — wire Model (`UsageModel`) and the `usage.record` Op
 * (`recordUsage`) for the agent's accumulated token usage.
 *
 * Declares usage as a wire Model (`byModel` totals) plus the single Op that
 * folds one `record` call into it. The persisted record carries exactly v1's
 * field set (`{ model, usage, usageScope }`); the per-turn accumulator is NOT
 * in the Model — it is live-only service state (see `usageService`), reset on
 * resume like v1 (v1 restore folds every `usage.record` as `session` scope and
 * never rebuilds `currentTurn`). `apply` is pure and ignores any extra fields
 * found on replayed legacy records (early v2 logs carried `turnId` / `context`).
 * Also declares the canonical `agent.status.updated` event shape on
 * `DomainEventMap`; the usage slice is published live by `usageService` after
 * each dispatch (never on replay). Consumed by the Agent-scope `usageService`.
 */

import { z } from 'zod';

import { addUsage, type TokenUsage } from '#/kosong/contract/usage';
import { defineModel } from '#/wire/model';

import type { UsageStatus } from './usage';

export type UsageRecordScope = 'session' | 'turn';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'agent.status.updated': {
      usage?: UsageStatus;
      swarmMode?: boolean;
      planMode?: boolean;
      model?: string;
      thinkingEffort?: string;
      maxContextTokens?: number;
      contextTokens?: number;
    };
  }
}

export interface UsageModelState {
  readonly byModel: Record<string, TokenUsage>;
}

export const UsageModel = defineModel<UsageModelState>('usage', () => ({ byModel: {} }));

declare module '#/wire/types' {
  interface PersistedOpMap {
    'usage.record': typeof recordUsage;
  }
}

export const recordUsage = UsageModel.defineOp('usage.record', {
  schema: z.object({
    model: z.string(),
    usage: z.custom<TokenUsage>(),
    usageScope: z.custom<UsageRecordScope>().optional(),
  }),
  apply: (s, p) => {
    const current = s.byModel[p.model];
    return {
      byModel: {
        ...s.byModel,
        [p.model]: current === undefined ? copyUsage(p.usage) : addUsage(current, p.usage),
      },
    };
  },
});

export function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

export function usageStatusFromState(
  model: UsageModelState,
  currentTurn?: TokenUsage,
): UsageStatus {
  const byModel = byModelSnapshot(model.byModel);
  const hasByModel = Object.keys(byModel).length > 0;
  return {
    byModel: hasByModel ? byModel : undefined,
    total: hasByModel ? totalUsage(byModel) : undefined,
    currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
  };
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
