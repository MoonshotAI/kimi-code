import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { renderPrompt } from "#/_base/utils/render-prompt";
import { estimateTokens, estimateTokensForMessages } from "#/_base/utils/tokens";
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import {
  IAgentLLMRequesterService,
  retryBackoffDelays,
  sleepForRetry,
  type LLMRequestFinish,
} from '#/agent/llmRequester';
import { IAgentLoopService, type TurnContextOverflowContext } from '#/agent/loop';
import { isAbortError } from '#/agent/loop/errors';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentReplayBuilderService } from '#/agent/replayBuilder';
import { IAgentRecordService } from '#/agent/record';
import {
  TODO_STORE_KEY,
  renderTodoList,
  type TodoItem,
} from '#/agent/todoList/tools/todo-list';
import { IAgentToolStoreService } from '#/agent/toolStore';
import { IAgentTurnService } from '#/agent/turn';
import { ITelemetryService } from '#/app/telemetry';
import { ErrorCodes, KimiError, isKimiError, toKimiErrorPayload } from "#/errors";
import {
  APIContextOverflowError,
  APIEmptyResponseError,
  createUserMessage,
  type TokenUsage,
} from '@moonshot-ai/kosong';
import compactionInstructionTemplate from './compaction-instruction.md?raw';
import {
  IAgentFullCompactionService,
  type CompactInput,
  type FullCompactionCompleteData,
} from './fullCompaction';
import {
  RuntimeCompactionStrategy,
  type CompactionStrategy,
} from './strategy';
import {
  type CompactionBeginData,
  type CompactionResult,
} from './types';

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
  readonly model: string | undefined;
}

class CompactionTruncatedError extends Error {
  constructor() {
    super('Compaction response was truncated before producing a complete summary.');
    this.name = 'CompactionTruncatedError';
  }
}

export class AgentFullCompactionService extends Disposable implements IAgentFullCompactionService {
  declare readonly _serviceBrand: undefined;
  private readonly strategy: CompactionStrategy;
  private compactionCountInTurn = 0;
  private compacting: ActiveCompaction | null = null;

  constructor(
    private readonly options: FullCompactionServiceOptions = {},
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolStoreService private readonly toolStore: IAgentToolStoreService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IAgentReplayBuilderService private readonly replayBuilder: IAgentReplayBuilderService,
    @IAgentExternalHooksService private readonly externalHooks: IAgentExternalHooksService,
    @IAgentTurnService turnService: IAgentTurnService,
    @IAgentLoopService loopService: IAgentLoopService,
  ) {
    super();
    this.strategy =
      this.options.compactionStrategy ??
      new RuntimeCompactionStrategy(() => this.profile.resolveModelContext());
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
      loopService.hooks.onContextOverflow.register('full-compaction', async (ctx, next) => {
        await this.onContextOverflow(ctx, next);
      }),
    );
    this._register(
      record.define('full_compaction.begin', {
        resume: (r) => {
          this.replayBuilder.push({
            type: 'compaction',
            instruction: r.instruction,
          });
        },
      }),
    );
    this._register(
      record.define('full_compaction.cancel', {
        resume: () => {
          this.replayBuilder.patchLast('compaction', { result: 'cancelled' });
        },
      }),
    );
    this._register(
      record.define('full_compaction.complete', {
        resume: (r) => {
          const message = compactionSummaryMessage(this.context.get());
          if (message === undefined) return;
          const summary = contextMessageText(message);
          this.replayBuilder.removeLastMessages(new Set([message]));
          this.replayBuilder.patchLast('compaction', {
            result: {
              summary,
              compactedCount: r.compactedCount,
              tokensBefore: r.tokensBefore,
              tokensAfter: r.tokensAfter,
            },
          });
        },
      }),
    );
  }

  get isCompacting(): boolean {
    return this.compacting !== null;
  }

  begin(input: CompactInput): boolean {
    if (this.compacting) return false;
    const data = this.beginData(input);
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

    this.record.append({ type: 'full_compaction.begin', ...data });
    this.record.signal({
      type: 'compaction.started',
      trigger: data.source,
      instruction: data.instruction,
    });

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
    this.record.append({ type: 'full_compaction.cancel' });
    active.abortController.abort();
    this.compacting = null;
    this.record.signal({ type: 'compaction.cancelled' });
  }

  private markCompleted(result: FullCompactionCompleteData): void {
    if (this.compacting === null) return;
    this.record.append({ type: 'full_compaction.complete', ...result });
    this.compacting = null;
  }

  private resetForTurn(): void {
    this.compactionCountInTurn = 0;
  }

  private async onContextOverflow(
    context: TurnContextOverflowContext,
    next: () => Promise<void>,
  ): Promise<void> {
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this.compacting) {
      await next();
      return;
    }
    context.handled = true;
    await this.block(context.signal, context.turnId);
  }

  private async beforeStep(signal: AbortSignal, turnId?: number): Promise<void> {
    this.checkAutoCompaction();
    if (this.strategy.shouldBlock(this.tokenCountWithPending())) {
      await this.block(signal, turnId);
    }
  }

  private async afterStep(): Promise<void> {
    if (this.strategy.checkAfterStep) {
      this.checkAutoCompaction(false);
    }
  }

  private checkAutoCompaction(throwOnLimit = true): boolean {
    if (this.compacting) return true;
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
    this.record.signal({ type: 'compaction.blocked', turnId });
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
      this.markCompleted(completeData(finalResult));
      this.record.signal({ type: 'compaction.completed', result: finalResult });
      this.externalHooks.triggerPostCompact({
        trigger: data.source,
        estimatedTokenCount: finalResult.tokensAfter,
      });
    } catch (error) {
      if (isAbortError(error)) return;
      const blockedByTurn = this.compacting === active && active.blockedByTurn;
      if (this.compacting === active) {
        this.cancel();
      }
      if (blockedByTurn) {
        throw error;
      }
      this.record.signal({
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

      await this.externalHooks.triggerPreCompact(
        { trigger: data.source, tokenCount: tokensBefore },
        signal,
      );

      const resolvedModel = this.profile.resolveModelContext();
      const maxContextTokens = resolvedModel.modelCapabilities.max_context_tokens;
      const defaultCompactionCap =
        maxContextTokens > 0
          ? Math.min(maxContextTokens, DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS)
          : undefined;
      const compactionMaxOutputSize = resolvedModel.maxOutputSize ?? defaultCompactionCap;

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      let attempt: CompactionAttemptResult | undefined;
      while (true) {
        const messagesToCompact = originalHistory.slice(0, compactedCount);
        const messages = [
          ...this.projector.project(messagesToCompact),
          createUserMessage(renderPrompt(compactionInstructionTemplate, {
            customInstruction: data.instruction ?? '',
          })),
        ];

        try {
          attempt = collectSummary(
            await this.llmRequester.request(
              {
                messages,
                maxOutputSize: compactionMaxOutputSize,
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
            compactedCount = this.strategy.reduceCompactOnOverflow(messagesToCompact);
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
        tokens_before: result.tokensBefore,
        tokens_after: result.tokensAfter,
        duration_ms: Date.now() - startedAt,
        compacted_count: result.compactedCount,
        retry_count: retryCount,
        round,
        thinking_level: this.profile.data().thinkingLevel,
        ...usageTelemetry(attempt.usage),
        ...data,
      });

      this.context.splice(
        0,
        compactedCount,
        [createCompactionSummaryMessage(summary)],
        result.tokensAfter,
      );
      return result;
    } catch (error) {
      if (isAbortError(error)) return undefined;
      this.telemetry.track('compaction_failed', {
        ...data,
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
    const raw = this.toolStore.data()[TODO_STORE_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter(isTodoItem).map((todo) => ({
      title: todo.title,
      status: todo.status,
    }));
  }

  private tokenCountWithPending(): number {
    return this.contextSize.getStatus().contextTokensWithPending;
  }

  private beginData(input: CompactInput): CompactionBeginData {
    return {
      source: input.source,
      instruction: input.instruction ?? input.customInstruction,
    };
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

  return { summary, usage: finish.usage, model: finish.model };
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

function compactionSummaryMessage(history: readonly ContextMessage[]): ContextMessage | undefined {
  const message = history[0];
  if (message?.origin?.kind !== 'compaction_summary') return undefined;
  return message;
}

function contextMessageText(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function historyUnchanged(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  // Only the compacted prefix must be intact. Messages appended to the tail
  // while the summary request was in flight are fine — the splice replaces just
  // the prefix and leaves the appended tail in place (matching legacy, which
  // compared `newHistory[i] !== originalHistory[i]` over the original length).
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
// (onLaunched / beforeStep / afterStep / onContextOverflow) that drive auto
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
