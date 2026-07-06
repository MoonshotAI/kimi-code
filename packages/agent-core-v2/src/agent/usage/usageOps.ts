/**
 * `usage` domain (L3) — wire Model (`UsageModel`) and the `usage.record` Op
 * (`recordUsage`) for the agent's accumulated token usage.
 *
 * Declares usage as a wire Model (`byModel` totals plus the optional
 * `currentTurn` accumulator keyed by turn id) plus the single Op that folds one
 * `record` call into it; the `apply` is the pure extraction of the former live
 * `apply` + `resume` facet (their common transition), so
 * `wire.dispatch(recordUsage(...))` and `wire.replay` produce identical state.
 * Also augments `SignalMap` with the `usage` slice of `agent.status.updated`
 * (merged with the other domains' slices). Consumed by the Agent-scope
 * `usageService`.
 */

import { addUsage, type TokenUsage } from '#/app/llmProtocol';
import type { LLMRequestSource } from '#/agent/llmRequester/llmRequester';
import { defineModel, defineOp } from '#/wire';

import type { UsageStatus } from './usage';

declare module '#/wire' {
  interface SignalMap {
    // Canonical declaration for the agent status-bar signal. Each domain emits a
    // subset; the full shape lives here so every `wire.signal({ type:
    // 'agent.status.updated', ... })` call site resolves the same merged type.
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
    p: { model: string; usage: TokenUsage; context?: LLMRequestSource },
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
});

function copyUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}
