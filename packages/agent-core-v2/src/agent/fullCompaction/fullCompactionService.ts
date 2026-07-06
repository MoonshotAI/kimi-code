import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { renderPrompt } from "#/_base/utils/render-prompt";
import { estimateTokens, estimateTokensForMessages } from "#/_base/utils/tokens";
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentContextSizeService } from '#/agent/contextSize';
import {
  IAgentLLMRequesterService,
  retryBackoffDelays,
  sleepForRetry,
  type LLMRequestFinish,
} from '#/agent/llmRequester';
import { IAgentLoopService, type TurnErrorContext } from '#/agent/loop';
import { isAbortError, isContextOverflowError } from '#/agent/loop/errors';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentTurnService } from '#/agent/turn';
import { ISessionTodoService, renderTodoList, type TodoItem } from '#/session/todo';
import {
  APIContextOverflowError,
  APIEmptyResponseError,
  createUserMessage,
  type Message,
  type TokenUsage
} from '#/app/llmProtocol';
import { IEventBus } from '#/app/event';
import { ITelemetryService } from '#/app/telemetry';
import { ErrorCodes, KimiError, isKimiError, toKimiErrorPayload } from "#/errors";
import { IAgentWireService, type IWireService } from '#/wire';
import compactionInstructionTemplate from './compaction-instruction.md?raw';
import {
  IAgentFullCompactionService,
  type CompactInput,
  type FullCompactionCompleteData,
  type FullCompactionDidCompactContext,
  type FullCompactionWillCompactContext,
} from './fullCompaction';
import {
  RuntimeCompactionStrategy,
  type CompactionStrategy,
} from './strategy';
import {
  CompactionModel,
  fullCompactionBegin,
  fullCompactionCancel,
  fullCompactionComplete,
} from './compactionOps';
import {
  type CompactionBeginData,
  type CompactionResult,
} from './types';
import { OrderedHookSlot } from '#/hooks';

// The `full_compaction.*` record shapes stay declared in `WireRecordMap`
// because the records still ride the shared `'wire'` log read by
// `wireRecord.restore()` / `getRecords()`: `microCompaction` registers a
// `full_compaction.complete` resumer against that stream. fullCompaction itself
// no longer registers resumers here — its state rebuilds from the same log via
// `wire.replay` into `CompactionModel`.
declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'full_compaction.begin': CompactionBeginData;
    'full_compaction.cancel': {};
    'full_compaction.complete': FullCompactionCompleteData;
  }
}

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;
const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS = 128 * 1024;

export interface FullCompactionServiceOptions {
  // Optional override for the compaction strategy. Defaults to the
  // model-window-driven RuntimeCompactionStrategy. Tests inject a fixed
  // strategy to force compaction without configuring a tiny model window.
  readonly compactionStrategy?: CompactionStrategy;
}

type CompactionTelemetryProperties = Record<string, string | number | boolean | undefined>;

interface ActiveCompaction {
  readonly abortController: AbortController;
  promise: Promise<void>;
  blockedByTurn: boolean;
}

interface CompactionAttemptResult {
  readonly summary: string;
  readonly usage: TokenUsage | null;
}

class CompactionTruncatedError extends Error {
  constructor() {
    super('Compaction response was truncated before producing a complete summary.');
    this.name = 'CompactionTruncatedError';
  }
}

export class AgentFullCompactionService extends Disposable implements IAgentFullCompactionService {
  declare readonly _serviceBrand: undefined;
  readonly hooks: IAgentFullCompactionService['hooks'] = {
    onWillCompact: new OrderedHookSlot<FullCompactionWillCompactContext>(),
    onDidCompact: new OrderedHookSlot<FullCompactionDidCompactContext>(),
  };

  private readonly strategy: CompactionStrategy;
  private compactionCountInTurn = 0;
  private compacting: ActiveCompaction | null = null;
  // Token count right after the last successful compaction. While nothing new
  // has been appended, the history is already in its minimal compacted form;
  // re-compacting would only summarize the summary again, so
  // checkAutoCompaction skips in that case.
  private lastCompactedTokenCount: number | null = null;
  // Counts provider-overflow recoveries in this turn that have not yet been
  // followed by a successful step. Trips maxOverflowCompactionAttempts to
  // stop an overflow -> compact -> overflow loop when compaction can no
  // longer shrink the request below the model window.
  private consecutiveOverflowCompactions = 0;

  constructor(
    private readonly options: FullCompactionServiceOptions = {},
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ISessionTodoService private readonly todo: ISessionTodoService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentTurnService turnService: IAgentTurnService,
    @IAgentLoopService loopService: IAgentLoopService,
  ) {
    super();
    this.strategy =
      this.options.compactionStrategy ??
      new RuntimeCompactionStrategy(() => this.profile.resolveModelContext());
    this._register(this.wire.onRestored(() => this.normalizeAfterReplay()));
    this._register(
      turnService.hooks.onLaunched.register('full-compaction-reset', async (_ctx, next) => {
        this.resetForTurn();
        await next();
      }),
    );
    this._register(
      loopService.hooks.beforeStep.register('full-compaction', async (ctx, next) => {
        await this.beforeStep(ctx.signal, ctx.turnId);
        await next();
      }),
    );
    this._register(
      loopService.hooks.afterStep.register('full-compaction', async (_ctx, next) => {
        await this.afterStep();
        await next();
      }),
    );
    this._register(
      loopService.hooks.onError.register('full-compaction', async (ctx, next) => {
        await this.onLoopError(ctx, next);
      }),
    );
  }

  get isCompacting(): boolean {
    return this.compacting !== null;
  }

  begin(input: CompactInput): boolean {
    if (this.compacting) return false;
    const data: CompactionBeginData = { source: input.source, instruction: input.instruction };
    if (data.source === 'manual') {
      this.compactionCountInTurn = 0;
    } else {
      this.compactionCountInTurn += 1;
    }
    if (this.compactionCountInTurn > this.strategy.maxCompactionPerTurn) return false;

    const history = this.context.get();
    const compactedCount = this.strategy.computeCompactCount(history, data.source);
    if (compactedCount === 0) {
      throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'No prefix that can be compacted in current history.');
    }

    this.wire.dispatch(fullCompactionBegin(data));

    const active: ActiveCompaction = {
      abortController: new AbortController(),
      promise: Promise.resolve(),
      blockedByTurn: false,
    };
    this.compacting = active;
    active.promise = this.compactionWorker(active, active.abortController.signal, data, compactedCount);
    return true;
  }

  cancel(): void {
    const active = this.compacting;
    if (active === null) return;
    this.wire.dispatch(fullCompactionCancel({}));
    active.abortController.abort();
    this.compacting = null;
    this.eventBus.publish({ type: 'compaction.cancelled' });
  }

  private markCompleted(result: FullCompactionCompleteData): void {
    if (this.compacting === null) return;
    this.wire.dispatch(fullCompactionComplete(result));
    this.compacting = null;
  }

  private normalizeAfterReplay(): void {
    // A compaction in flight when the session was torn down cannot resume — the
    // worker and its AbortController are gone — so a `running` phase replayed
    // from the log is stranded. Collapse it back to idle silently: no live
    // `compaction.cancelled` signal, since restore must stay quiet.
    if (this.wire.getModel(CompactionModel).phase !== 'running') return;
    this.wire.dispatch(fullCompactionCancel({}));
  }

  private resetForTurn(): void {
    this.compactionCountInTurn = 0;
    this.lastCompactedTokenCount = null;
    this.consecutiveOverflowCompactions = 0;
  }

  private async onLoopError(
    context: TurnErrorContext,
    next: () => Promise<void>,
  ): Promise<void> {
    if (!isContextOverflowError(context.error)) {
      await next();
      return;
    }
    this.consecutiveOverflowCompactions += 1;
    const maxAttempts = this.strategy.maxOverflowCompactionAttempts;
    if (this.consecutiveOverflowCompactions > maxAttempts) {
      throw new KimiError(
        ErrorCodes.CONTEXT_OVERFLOW,
        `Compaction failed to bring the context under the model window after ${String(maxAttempts)} attempts.`,
        { cause: context.error instanceof Error ? context.error : undefined },
      );
    }
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this.compacting) {
      await next();
      return;
    }
    context.retry = true;
    await this.block(context.signal, context.turnId);
  }

  private async beforeStep(signal: AbortSignal, turnId?: number): Promise<void> {
    this.checkAutoCompaction();
    if (this.strategy.shouldBlock(this.tokenCountWithPending())) {
      await this.block(signal, turnId);
    }
  }

  private async afterStep(): Promise<void> {
    // A completed step means a request succeeded, so any prior
    // overflow -> compact cycle produced a request that now fits; clear the
    // loop guard.
    this.consecutiveOverflowCompactions = 0;
    if (this.strategy.checkAfterStep) {
      this.checkAutoCompaction(false);
    }
  }

  private checkAutoCompaction(throwOnLimit = true): boolean {
    if (this.compacting) return true;
    if (
      this.lastCompactedTokenCount !== null &&
      this.tokenCountWithPending() <= this.lastCompactedTokenCount
    ) {
      return false;
    }
    if (!this.strategy.shouldCompact(this.tokenCountWithPending())) return false;
    return this.beginAutoCompaction(throwOnLimit);
  }

  private beginAutoCompaction(throwOnLimit = true): boolean {
    if (this.compacting) return true;
    const maxCompactions = this.strategy.maxCompactionPerTurn;
    if (this.compactionCountInTurn >= maxCompactions) {
      if (throwOnLimit) {
        throw new KimiError(ErrorCodes.CONTEXT_OVERFLOW, `Compaction limit exceeded (${String(maxCompactions)})`, {
          details: { maxCompactions },
        });
      }
      return false;
    }
    return this.begin({ source: 'auto' });
  }

  private async block(signal?: AbortSignal, turnId?: number): Promise<void> {
    const active = this.compacting;
    if (active === null) return;
    active.blockedByTurn = true;
    if (signal !== undefined) {
      signal.addEventListener('abort', () => {
        if (this.compacting === active) {
          this.cancel();
        }
      }, { once: true });
    }
    this.eventBus.publish({ type: 'compaction.blocked', turnId });
    await active.promise;
  }

  private async compactionWorker(
    active: ActiveCompaction,
    signal: AbortSignal,
    data: Readonly<CompactionBeginData>,
    initialCompactedCount: number,
  ): Promise<void> {
    try {
      const finalResult: CompactionResult = {
        summary: '',
        compactedCount: 1,
        tokensBefore: 0,
        tokensAfter: 0,
      };
      let compactedCount = initialCompactedCount;

      for (let round = 1; ; round++) {
        const result = await this.compactionRound(round, signal, data, compactedCount);
        if (result === undefined) return;
        if (this.compacting !== active) return;

        finalResult.summary = result.summary;
        finalResult.compactedCount += result.compactedCount - 1;
        finalResult.tokensBefore += result.tokensBefore - finalResult.tokensAfter;
        finalResult.tokensAfter = result.tokensAfter;

        if (result.tokensBefore - result.tokensAfter < 1024) break;
        if (!this.strategy.shouldBlock(result.tokensAfter)) break;
        compactedCount = this.strategy.computeCompactCount(this.context.get(), data.source);
        if (compactedCount === 0) break;
      }

      if (this.compacting !== active) return;
      this.lastCompactedTokenCount = finalResult.tokensAfter;
      this.markCompleted(completeData(finalResult));
      this.eventBus.publish({ type: 'compaction.completed', result: finalResult });
      void this.hooks.onDidCompact.run({
        trigger: data.source,
        estimatedTokenCount: finalResult.tokensAfter,
      }).catch(() => undefined);
    } catch (error) {
      if (isAbortError(error)) return;
      const blockedByTurn = this.compacting === active && active.blockedByTurn;
      if (this.compacting === active) {
        this.cancel();
      }
      if (blockedByTurn) {
        throw error;
      }
      this.eventBus.publish({
        type: 'error',
        ...toKimiErrorPayload(error),
      });
    }
  }

  private async compactionRound(
    round: number,
    signal: AbortSignal,
    data: Readonly<CompactionBeginData>,
    initialCompactedCount: number,
  ): Promise<CompactionResult | undefined> {
    const startedAt = Date.now();
    const originalHistory = [...this.context.get()];
    const tokensBefore = estimateTokensForMessages(originalHistory);
    let retryCount = 0;

    try {
      let compactedCount = initialCompactedCount;
      signal.throwIfAborted();

      // One logical compaction fires the hook once, even when it takes
      // multiple window-sized rounds to bring the context under the ratio.
      if (round === 1) {
        await this.hooks.onWillCompact.run({
          trigger: data.source,
          tokenCount: tokensBefore,
          signal,
        });
      }

      const resolvedModel = this.profile.resolveModelContext();
      const maxContextTokens = resolvedModel.modelCapabilities.max_context_tokens;
      const defaultCompactionCap =
        maxContextTokens > 0
          ? Math.min(maxContextTokens, DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS)
          : undefined;
      const compactionMaxOutputSize = resolvedModel.maxOutputSize ?? defaultCompactionCap;

      const instruction = renderPrompt(compactionInstructionTemplate, {
        customInstruction: data.instruction?.trim() ?? '',
      }).trimEnd();

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      let attempt: CompactionAttemptResult | undefined;
      while (true) {
        const messagesToCompact = originalHistory.slice(0, compactedCount);
        // Raw context slice — `llmRequester` projects every request once;
        // projecting here too would run micro-compaction on shifted indices.
        const messages: Message[] = [...messagesToCompact, createUserMessage(instruction)];

        try {
          attempt = collectSummary(
            await this.llmRequester.request(
              {
                messages,
                maxOutputSize: compactionMaxOutputSize,
                source: { type: 'operation', requestKind: 'full_compaction' },
              },
              undefined,
              signal,
            ),
          );
          break;
        } catch (error) {
          if (
            error instanceof APIContextOverflowError ||
            error instanceof CompactionTruncatedError ||
            error instanceof APIEmptyResponseError
          ) {
            const reduced = this.strategy.reduceCompactOnOverflow(messagesToCompact);
            // An overflow that cannot shrink further would replay the same
            // request; give up (v1: throws when the history cannot shrink).
            if (error instanceof APIContextOverflowError && reduced >= compactedCount) {
              throw error;
            }
            compactedCount = reduced;
          } else {
            throw error;
          }
          if (retryCount + 1 >= MAX_COMPACTION_RETRY_ATTEMPTS) {
            throw error;
          }
          await sleepForRetry(delays[retryCount]!, signal);
          retryCount += 1;
        }
      }

      if (attempt === undefined) {
        throw new APIEmptyResponseError(
          'The compaction response did not contain a usable summary.',
        );
      }

      if (!historyUnchanged(this.context.get(), originalHistory)) {
        this.cancel();
        return undefined;
      }

      const summary = this.postProcessSummary(attempt.summary);
      const recent = originalHistory.slice(compactedCount);
      const tokensAfter = estimateTokens(summary) + estimateTokensForMessages(recent);
      const result: CompactionResult = {
        summary,
        compactedCount,
        tokensBefore,
        tokensAfter,
      };

      this.telemetry.track('compaction_finished', {
        // Never send `data.instruction` (user-authored content) to telemetry.
        source: data.source,
        tokens_before: result.tokensBefore,
        tokens_after: result.tokensAfter,
        duration_ms: Date.now() - startedAt,
        compacted_count: result.compactedCount,
        retry_count: retryCount,
        round,
        thinking_level: this.profile.data().thinkingLevel,
        ...usageTelemetry(attempt.usage),
      });

      this.context.applyCompaction({
        count: compactedCount,
        summary: createCompactionSummaryMessage(summary),
        tokens: result.tokensAfter,
      });
      return result;
    } catch (error) {
      if (isAbortError(error)) return undefined;
      this.telemetry.track('compaction_failed', {
        source: data.source,
        tokens_before: tokensBefore,
        duration_ms: Date.now() - startedAt,
        round,
        retry_count: retryCount,
        thinking_level: this.profile.data().thinkingLevel,
        error_type: error instanceof Error ? error.name : 'Unknown',
      });
      if (isKimiError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED) throw error;
      throw new KimiError(ErrorCodes.COMPACTION_FAILED, String(error), { cause: error });
    }
  }

  private postProcessSummary(summary: string): string {
    const todos = this.currentTodos();
    if (todos.length === 0) {
      return summary;
    }
    return `${summary.trim()}\n\n${renderTodoList(todos, '## TODO List')}`;
  }

  private currentTodos(): readonly TodoItem[] {
    return this.todo.getTodos();
  }

  private tokenCountWithPending(): number {
    return this.contextSize.getStatus().contextTokensWithPending;
  }
}

function collectSummary(finish: LLMRequestFinish): CompactionAttemptResult {
  if (finish.providerFinishReason === 'truncated') {
    throw new CompactionTruncatedError();
  }

  const summary = finish.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  if (summary.length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }

  return { summary, usage: finish.usage };
}

function createCompactionSummaryMessage(summary: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: summary }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

function completeData(result: CompactionResult): FullCompactionCompleteData {
  return {
    compactedCount: result.compactedCount,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
  };
}

function historyUnchanged(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  // Only the compacted prefix must be intact. Messages appended to the tail
  // while the summary request was in flight are fine — unlike legacy's
  // whole-history rebuild (which had to cancel when non-user messages grew the
  // tail), the splice replaces just the prefix and leaves the appended tail in
  // place, so nothing appended concurrently can be lost.
  if (current.length < original.length) return false;
  return original.every((message, index) => message === current[index]);
}

function usageTelemetry(usage: TokenUsage | null): CompactionTelemetryProperties {
  if (usage === null) return {};
  return {
    input_other: usage.inputOther,
    output: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

function isTodoItem(value: unknown): value is TodoItem {
  if (value === null || typeof value !== 'object') return false;
  const item = value as { title?: unknown; status?: unknown };
  return (
    typeof item.title === 'string' &&
    (item.status === 'pending' || item.status === 'in_progress' || item.status === 'done')
  );
}

export { AgentFullCompactionService as FullCompaction };

// Construct eagerly (not delayed): the service registers turn and loop hooks
// (onLaunched / beforeStep / afterStep / onError) that drive auto
// compaction. With delayed instantiation the eager `accessor.get(IAgentFullCompactionService)`
// only realizes a proxy, so the hooks would not register until the first RPC —
// after turns have already run without the auto-compaction gate.
registerScopedService(
  LifecycleScope.Agent,
  IAgentFullCompactionService,
  AgentFullCompactionService,
  InstantiationType.Eager,
  'fullCompaction',
);
