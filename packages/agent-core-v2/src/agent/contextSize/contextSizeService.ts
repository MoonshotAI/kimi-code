/**
 * `contextSize` domain (L4) — `IAgentContextSizeService` implementation.
 *
 * Owns the last measured context token count in the wire `ContextSizeModel`
 * (`{ length, tokens }`): reads it through `wire.getModel`, writes it through
 * `wire.dispatch(contextSizeMeasured(...))` (called by `llmRequester` after each
 * measured exchange), and derives the `contextTokens` slice of
 * `agent.status.updated` from the Op's `toEvent` (published to `IEventBus` on
 * dispatch) when the measured value changes. `get(start?, end?)` returns `{ size, measured, estimated }` for the
 * context-message range `[start, end)`, resolved like `Array.prototype.slice`
 * (defaulting to the whole context; negative indices count back from the end;
 * an inverted range is empty): `measured`
 * is the deterministic measured value of the measured-prefix portion
 * (replay-safe; the exact aggregate is only known for the full prefix, so
 * sub-ranges fall back to a per-message estimate), `estimated` is the live token
 * estimate of the not-yet-measured portion, and `size = measured + estimated`.
 * The sparse `measuredPrefixTokens` / per-message `estimates` are deliberately
 * not persisted (see `contextSizeOps`). Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { estimateTokensForMessages } from '#/_base/utils/tokens';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Message } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import { IWireService } from '#/wire/wire';

import { IAgentContextSizeService, type ContextSize } from './contextSize';
import { ContextSizeModel, contextSizeMeasured } from './contextSizeOps';

export class AgentContextSizeService extends Disposable implements IAgentContextSizeService {
  declare readonly _serviceBrand: undefined;

  private lastEmittedTokens = 0;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IWireService private readonly wire: IWireService,
  ) {
    super();
  }

  get(start?: number, end?: number): ContextSize {
    const context = this.context.get();
    const model = this.wire.getModel(ContextSizeModel);
    // Defensive clamp: the measured prefix can never be longer than the live
    // context. An op written against a mutated message array once inflated
    // `model.length` past `context.length`, silently knocking every read off
    // the measured path onto the per-message estimate branch.
    const measuredLength = Math.min(model.length, context.length);
    const from = normalizeSliceIndex(start ?? 0, context.length);
    const to = normalizeSliceIndex(end ?? context.length, context.length);
    const measuredEnd = Math.min(to, measuredLength);
    const estimatedStart = Math.max(from, measuredLength);
    const measured =
      from === 0 && measuredEnd === measuredLength
        ? model.tokens
        : estimateTokensForMessages(context.slice(from, measuredEnd));
    const estimated = estimateTokensForMessages(context.slice(estimatedStart, to));
    return { size: measured + estimated, measured, estimated };
  }

  measured(input: readonly Message[], output: readonly Message[], usage: TokenUsage): void {
    const context = this.context.get();
    if (!matchesContext(input, context)) return;
    // The fold of the step's loop events creates the assistant message in the
    // context BEFORE the exchange finishes (a skeleton at `step.begin`, filled
    // by `content.part` folds during streaming), and `input` is that same live
    // array — so it already includes `output` here. The measured prefix is the
    // whole current context; `input.length + output.length` would count the
    // folded output twice.
    const length = context.length;
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

function normalizeSliceIndex(index: number, length: number): number {
  if (index < 0) return Math.max(length + index, 0);
  return Math.min(index, length);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextSizeService,
  AgentContextSizeService,
  InstantiationType.Eager,
  'contextSize',
);
