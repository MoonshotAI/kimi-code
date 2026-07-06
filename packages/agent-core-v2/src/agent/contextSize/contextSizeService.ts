/**
 * `contextSize` domain (L4) — `IAgentContextSizeService` implementation.
 *
 * Owns the last measured context token count in the wire `ContextSizeModel`
 * (`{ length, tokens }`): reads it through `wire.getModel`, writes it through
 * `wire.dispatch(contextSizeMeasured(...))` (called by `llmRequester` after each
 * measured exchange), and emits the `contextTokens` slice of
 * `agent.status.updated` live through `wire.signal` when the measured value
 * changes. `getStatus().contextTokens` is the deterministic measured value
 * (replay-safe); `contextTokensWithPending` adds the live token estimate of the
 * not-yet-measured tail, computed at read time from the surviving
 * `contextMemory` messages beyond the measured prefix — the sparse
 * `measuredPrefixTokens` / per-message `estimates` are deliberately not
 * persisted (see `contextSizeOps`). Bound at Agent scope.
 */

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { estimateTokensForMessage } from '#/_base/utils/tokens';
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import type { Message, TokenUsage } from '#/app/llmProtocol';
import { IAgentWireService, type IWireService } from '#/wire';

import { IAgentContextSizeService, type ContextSizeStatus } from './contextSize';
import { ContextSizeModel, contextSizeMeasured } from './contextSizeOps';

export class AgentContextSizeService extends Disposable implements IAgentContextSizeService {
  declare readonly _serviceBrand: undefined;

  private lastEmittedTokens = 0;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentWireService private readonly wire: IWireService,
  ) {
    super();
  }

  getStatus(): ContextSizeStatus {
    const measured = this.wire.getModel(ContextSizeModel);
    const pendingTokens = estimateTail(this.context.get(), measured.length);
    return {
      contextTokens: measured.tokens,
      contextTokensWithPending: measured.tokens + pendingTokens,
    };
  }

  measured(input: readonly Message[], output: readonly Message[], usage: TokenUsage): void {
    // Only adopt the measurement when `input` still matches the live context.
    // This rejects stale readings (e.g. the context was spliced, or the request
    // used overridden messages) so a mismatched measurement cannot poison state.
    if (!matchesContext(input, this.context.get())) return;
    const length = input.length + output.length;
    const tokens = tokenUsageTotal(usage);
    this.wire.dispatch(contextSizeMeasured({ length, tokens }));
    this.emitIfChanged();
  }

  private emitIfChanged(): void {
    const tokens = this.wire.getModel(ContextSizeModel).tokens;
    if (tokens === this.lastEmittedTokens) return;
    this.lastEmittedTokens = tokens;
  }
}

function matchesContext(input: readonly Message[], context: readonly ContextMessage[]): boolean {
  if (input.length !== context.length) return false;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== context[index]) return false;
  }
  return true;
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
}

function estimateTail(
  context: readonly ContextMessage[],
  measuredLength: number,
): number {
  let total = 0;
  for (let index = measuredLength; index < context.length; index += 1) {
    const message = context[index];
    if (message !== undefined) total += estimateTokensForMessage(message);
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
