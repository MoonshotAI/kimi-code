/**
 * `usage` domain (L3) — wire Model (`UsageModel`) and the `usage.record` Op
 * (`recordUsage`) for the agent's accumulated token usage.
 *
 * Declares usage as a wire Model (`byModel` totals plus the optional
 * `currentTurn` accumulator keyed by turn id) plus the single Op that folds one
 * `record` call into it; the `apply` is the pure extraction of the former live
 * `apply` + `resume` facet (their common transition), so
 * `wire.dispatch(recordUsage(...))` and `wire.replay` produce identical state.
 * Also augments `DomainEventMap` with the `usage` slice of `agent.status.updated`,
 * derived from the `usage.record` Op's `toEvent`. Consumed by the Agent-scope
 * `usageService`.
 */

import { addUsage, type TokenUsage } from '#/app/llmProtocol/usage';
import type { LLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { defineModel, defineOp } from '#/wire';

import type { UsageStatus } from './usage';

export type UsageRecordScope = 'session' | 'turn';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    // Canonical declaration for the agent status-bar event (`IEventBus`); each
    // domain derives/publishes a subset.
    'agent.status.updated': {
      usage?: UsageStatus;
      swarmMode?: boolean;
      planMode?: boolean;
      model?: string;
      maxContextTokens?: number;
      contextTokens?: number;
    };
  }
}

export interface UsageModelState {
  readonly byModel: Record<string, TokenUsage>;
  readonly currentTurnId?: number;
  readonly currentTurn?: TokenUsage;
}

export const UsageModel = defineModel<UsageModelState>('usage', () => ({ byModel: {} }));

export const recordUsage = defineOp(UsageModel, 'usage.record', {
  apply: (
    s,
    p: {
      model: string;
      usage: TokenUsage;
      usageScope?: UsageRecordScope;
      context?: LLMRequestSource;
    },
  ): UsageModelState => {
    const current = s.byModel[p.model];
    const byModel = {
      ...s.byModel,
      [p.model]: current === undefined ? copyUsage(p.usage) : addUsage(current, p.usage),
    };

    const source = p.context;
    if (source?.type !== 'turn') {
      return { byModel, currentTurnId: s.currentTurnId, currentTurn: s.currentTurn };
    }

    if (s.currentTurnId !== source.turnId) {
      return { byModel, currentTurnId: source.turnId, currentTurn: copyUsage(p.usage) };
    }
    return {
      byModel,
      currentTurnId: s.currentTurnId,
      currentTurn:
        s.currentTurn === undefined ? copyUsage(p.usage) : addUsage(s.currentTurn, p.usage),
    };
  },
  toEvent: (_p, state) => ({
    type: 'agent.status.updated' as const,
    usage: usageStatusFromState(state),
  }),
});

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}

export function usageStatusFromState(model: UsageModelState): UsageStatus {
  const byModel = byModelSnapshot(model.byModel);
  const hasByModel = Object.keys(byModel).length > 0;
  const currentTurn = model.currentTurn;
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
