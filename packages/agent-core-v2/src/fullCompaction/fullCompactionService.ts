import {
  APIContextOverflowError,
  APIEmptyResponseError,
  createUserMessage,
  isContentPart,
  isRetryableGenerateError,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
} from "#/_base/di";
import { ErrorCodes, KimiError, isKimiError, toKimiErrorPayload } from "#/_base/errors";
import { isAbortError } from '../../../loop/errors';
import { retryBackoffDelays, sleepForRetry } from '../../../loop/retry';
import { estimateTokens, estimateTokensForMessages } from "#/_base/utils/tokens";
import { renderPrompt } from "#/_base/utils/render-prompt";
import compactionInstructionTemplate from '../../../agent/compaction/compaction-instruction.md?raw';
import {
  type CompactionBeginData,
  type CompactionResult,
  type CompactionStrategy,
} from '../../../agent/compaction';
import {
  TODO_STORE_KEY,
  renderTodoList,
  type TodoItem,
} from '../../../tools/builtin/state/todo-list';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IContextProjector } from '../contextProjector/contextProjector';
import { IContextSizeService } from '../contextSize/contextSize';
import { IEventBus } from '../eventBus/eventBus';
import { IExternalHooksService } from '../externalHooks/externalHooks';
import { ILLMRequester } from '../llmRequester/llmRequester';
import { IProfileService } from '../profile/profile';
import { IReplayBuilderService } from '../replayBuilder/replayBuilder';
import { ITelemetryService } from '../telemetry/telemetry';
import { IToolStoreService } from '../toolStore/toolStore';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage, LLMEvent } from '../types';
import { IUsageService } from '../usage/usage';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  IFullCompaction,
  type CompactInput,
  type FullCompactionCompleteData,
} from './fullCompaction';
import { RuntimeCompactionStrategy } from './compactionStrategy';

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;

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

export class FullCompactionService extends Disposable implements IFullCompaction {
  private readonly strategy: CompactionStrategy;
  private compactionCountInTurn = 0;
  private compacting: ActiveCompaction | null = null;

  constructor(
    private readonly options: FullCompactionServiceOptions = {},
    @IContextMemory private readonly context: IContextMemory,
    @IContextProjector private readonly projector: IContextProjector,
    @IContextSizeService private readonly contextSize: IContextSizeService,
    @ILLMRequester private readonly llmRequester: ILLMRequester,
    @IProfileService private readonly profile: IProfileService,
    @IToolStoreService private readonly toolStore: IToolStoreService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IUsageService private readonly usage: IUsageService,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @IReplayBuilderService private readonly replayBuilder: IReplayBuilderService,
    @IExternalHooksService private readonly externalHooks: IExternalHooksService,
    @ITurnRunner turnRunner: ITurnRunner,
  ) {
    super();
    this.strategy =
      this.options.compactionStrategy ??
      new RuntimeCompactionStrategy(() => this.profile.resolveModelContext());
    this._register(
      turnRunner.hooks.onLaunched.register('full-compaction-reset', async (_ctx, next) => {
        this.resetForTurn();
        await next();
      }),
    );
    this._register(
      turnRunner.hooks.beforeStep.register('full-compaction', async (ctx, next) => {
        await this.beforeStep(ctx.turn.abortController.signal, ctx.turn.id);
        await next();
      }),
    );
    this._register(
      turnRunner.hooks.afterStep.register('full-compaction', async (_ctx, next) => {
        await this.afterStep();
        await next();
      }),
    );
    this._register(
      wireRecord.register('full_compaction.begin', (record) => {
        this.replayBuilder.push({
          type: 'compaction',
          instruction: record.instruction,
        });
      }),
    );
    this._register(
      wireRecord.register('full_compaction.cancel', () => {
        this.replayBuilder.patchLast('compaction', { result: 'cancelled' });
      }),
    );
    this._register(
      wireRecord.register('full_compaction.complete', (record) => {
        const summary = compactionSummaryText(this.context.getHistory());
        if (summary === undefined) return;
        this.replayBuilder.patchLast('compaction', {
          result: {
            summary,
            compactedCount: record.compactedCount,
            tokensBefore: record.tokensBefore,
            tokensAfter: record.tokensAfter,
          },
        });
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

    const history = this.context.getHistory();
    const compactedCount = this.strategy.computeCompactCount(history, data.source);
    if (compactedCount === 0) {
      throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'No prefix that can be compacted in current history.');
    }

    this.wireRecord.append({ type: 'full_compaction.begin', ...data });
    this.events.emit({
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
    this.wireRecord.append({ type: 'full_compaction.cancel' });
    active.abortController.abort();
    this.compacting = null;
    this.events.emit({ type: 'compaction.cancelled' });
  }

  private markCompleted(result: FullCompactionCompleteData): void {
    if (this.compacting === null) return;
    this.wireRecord.append({ type: 'full_compaction.complete', ...result });
    this.compacting = null;
  }

  private resetForTurn(): void {
    this.compactionCountInTurn = 0;
  }

  async handleOverflowError(
    signal: AbortSignal,
    error: unknown,
    turnId?: number,
  ): Promise<void> {
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this.compacting) throw error;
    await this.block(signal, turnId);
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
    this.events.emit({ type: 'compaction.blocked', turnId });
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
        compactedCount = this.strategy.computeCompactCount(this.context.getHistory(), data.source);
        if (compactedCount === 0) break;
      }

      if (this.compacting !== active) return;
      this.markCompleted(completeData(finalResult));
      this.events.emit({ type: 'compaction.completed', result: finalResult });
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
      this.events.emit({
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
    const originalHistory = [...this.context.getHistory()];
    const tokensBefore = estimateTokensForMessages(originalHistory);
    let retryCount = 0;

    try {
      let compactedCount = initialCompactedCount;
      signal.throwIfAborted();

      await this.externalHooks.triggerPreCompact(
        { trigger: data.source, tokenCount: tokensBefore },
        signal,
      );

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
          attempt = await collectSummary(this.llmRequester.request({ messages, tools: [] }, signal));
          break;
        } catch (error) {
          if (
            error instanceof APIContextOverflowError ||
            error instanceof CompactionTruncatedError ||
            error instanceof APIEmptyResponseError
          ) {
            compactedCount = this.strategy.reduceCompactOnOverflow(messagesToCompact);
          } else if (!isRetryableGenerateError(error)) {
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

      if (attempt.usage !== null) {
        this.usage.record(
          attempt.model ?? this.profile.resolveModelContext().modelAlias,
          attempt.usage,
        );
      }

      if (!historyUnchanged(this.context.getHistory(), originalHistory)) {
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
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        duration: Date.now() - startedAt,
        compactedCount: result.compactedCount,
        retryCount,
        round,
        thinkingLevel: this.profile.data().thinkingLevel,
        ...usageTelemetry(attempt.usage),
        ...data,
      });

      this.context.spliceHistory(
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
        tokensBefore,
        duration: Date.now() - startedAt,
        round,
        retryCount,
        thinkingLevel: this.profile.data().thinkingLevel,
        errorType: error instanceof Error ? error.name : 'Unknown',
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

async function collectSummary(events: AsyncIterable<LLMEvent>): Promise<CompactionAttemptResult> {
  const parts: string[] = [];
  let usage: TokenUsage | null = null;
  let model: string | undefined;
  let truncated = false;

  for await (const event of events) {
    switch (event.type) {
      case 'part':
        if (isContentPart(event.part) && event.part.type === 'text') {
          parts.push(event.part.text);
        }
        break;
      case 'usage':
        usage = event.usage;
        model = event.model;
        break;
      case 'finish':
        truncated = event.providerFinishReason === 'truncated';
        break;
      case 'timing':
        break;
    }
  }

  if (truncated) {
    throw new CompactionTruncatedError();
  }

  const summary = parts.join('').trim();
  if (summary.length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }

  return { summary, usage, model };
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

function compactionSummaryText(history: readonly ContextMessage[]): string | undefined {
  const message = history[0];
  if (message?.origin?.kind !== 'compaction_summary') return undefined;
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
    inputOther: usage.inputOther,
    output: usage.output,
    inputCacheRead: usage.inputCacheRead,
    inputCacheCreation: usage.inputCacheCreation,
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

export { FullCompactionService as FullCompaction };

// Construct eagerly (not delayed): the service registers turn-lifecycle hooks
// (onLaunched / beforeStep / afterStep) in its constructor that drive auto
// compaction. With delayed instantiation the eager `accessor.get(IFullCompaction)`
// only realizes a proxy, so the hooks would not register until the first RPC —
// after turns have already run without the auto-compaction gate.
registerSingleton(IFullCompaction, new SyncDescriptor(FullCompactionService, [{}], false));
