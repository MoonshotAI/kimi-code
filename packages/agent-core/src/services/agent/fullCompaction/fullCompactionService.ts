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
} from '../../../di';
import { ErrorCodes, KimiError, isKimiError } from '../../../errors';
import { isAbortError } from '../../../loop/errors';
import { retryBackoffDelays, sleepForRetry } from '../../../loop/retry';
import { estimateTokens, estimateTokensForMessages } from '../../../utils/tokens';
import { renderPrompt } from '../../../utils/render-prompt';
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
import { IEventBus } from '../eventBus/eventBus';
import { OrderedHookSlot } from '../hooks';
import { ILLMRequester } from '../llmRequester/llmRequester';
import { IToolStoreService } from '../toolStore/toolStore';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage, LLMEvent } from '../types';
import { IUsageService } from '../usage/usage';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  IFullCompaction,
  type CompactInput,
  type PostCompactContext,
  type PreCompactContext,
} from './fullCompaction';
import { RuntimeCompactionStrategy } from './compactionStrategy';

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;

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

  readonly hooks = {
    preCompact: new OrderedHookSlot<PreCompactContext>(),
    postCompact: new OrderedHookSlot<PostCompactContext>(),
  };

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IContextProjector private readonly projector: IContextProjector,
    @ILLMRequester private readonly llmRequester: ILLMRequester,
    @IToolStoreService private readonly toolStore: IToolStoreService,
    @IUsageService private readonly usage: IUsageService,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @ITurnRunner turnRunner: ITurnRunner,
  ) {
    super();
    this.strategy = new RuntimeCompactionStrategy(() => this.llmRequester.getModelContext());
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

    const compactedCount = this.strategy.computeCompactCount(this.context.getHistory(), data.source);
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

  async compact(input: CompactInput): Promise<void> {
    this.begin(input);
    await this.block(input.signal);
  }

  cancel(): void {
    const active = this.compacting;
    if (active === null) return;
    this.wireRecord.append({ type: 'full_compaction.cancel' });
    active.abortController.abort();
    this.compacting = null;
    this.events.emit({ type: 'compaction.cancelled' });
  }

  markCompleted(): void {
    if (this.compacting === null) return;
    this.wireRecord.append({ type: 'full_compaction.complete' });
    this.compacting = null;
  }

  resetForTurn(): void {
    this.compactionCountInTurn = 0;
  }

  async handleOverflowError(
    signal: AbortSignal,
    error: unknown,
    turnId?: string,
  ): Promise<void> {
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this.compacting) throw error;
    await this.block(signal, turnId);
  }

  async beforeStep(signal: AbortSignal, turnId?: string): Promise<void> {
    this.checkAutoCompaction();
    if (this.strategy.shouldBlock(this.tokenCountWithPending())) {
      await this.block(signal, turnId);
    }
  }

  async afterStep(): Promise<void> {
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

  private async block(signal?: AbortSignal, turnId?: string): Promise<void> {
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
    if (turnId !== undefined) {
      this.events.emit({ type: 'compaction.blocked', turnId });
    }
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
      this.markCompleted();
      this.events.emit({ type: 'compaction.completed', result: finalResult });
      void this.hooks.postCompact.run({
        trigger: data.source,
        estimatedTokenCount: finalResult.tokensAfter,
        result: finalResult,
      });
    } catch (error) {
      if (isAbortError(error)) return;
      const blockedByTurn = this.compacting === active && active.blockedByTurn;
      if (this.compacting === active) {
        this.cancel();
      }
      this.events.emit({
        type: 'compaction.failed',
        source: data.source,
        instruction: data.instruction,
        error: serializeCompactionError(error),
      });
      if (blockedByTurn) {
        throw error;
      }
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
      await this.triggerPreCompactHook(data, tokensBefore, signal);

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
          attempt = await collectSummary(this.llmRequester.request({ messages }, signal));
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
        this.usage.record(attempt.model ?? this.llmRequester.getModelContext().modelAlias, attempt.usage);
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

      this.events.emit({
        type: 'compaction.telemetry',
        event: 'compaction_finished',
        properties: {
          source: data.source,
          hasInstruction: data.instruction !== undefined && data.instruction.length > 0,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          duration: Date.now() - startedAt,
          compactedCount: result.compactedCount,
          retryCount,
          round,
          ...usageTelemetry(attempt.usage),
        },
      });

      this.context.spliceHistory(0, compactedCount, createCompactionSummaryMessage(summary));
      return result;
    } catch (error) {
      if (isAbortError(error)) return undefined;
      this.events.emit({
        type: 'compaction.telemetry',
        event: 'compaction_failed',
        properties: {
          source: data.source,
          hasInstruction: data.instruction !== undefined && data.instruction.length > 0,
          tokensBefore,
          duration: Date.now() - startedAt,
          round,
          retryCount,
          errorType: error instanceof Error ? error.name : 'Unknown',
        },
      });
      if (isKimiError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED) throw error;
      throw new KimiError(ErrorCodes.COMPACTION_FAILED, String(error), { cause: error });
    }
  }

  private async triggerPreCompactHook(
    data: Readonly<CompactionBeginData>,
    tokenCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.hooks.preCompact.run({
      trigger: data.source,
      tokenCount,
      signal,
    });
    signal.throwIfAborted();
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
    return estimateTokensForMessages(this.context.getHistory());
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

function historyUnchanged(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  if (current.length !== original.length) return false;
  return current.every((message, index) => message === original[index]);
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

function serializeCompactionError(error: unknown): {
  code: string | undefined;
  name: string | undefined;
  message: string;
} {
  return {
    code: isKimiError(error) ? error.code : undefined,
    name: error instanceof Error ? error.name : undefined,
    message: error instanceof Error ? error.message : String(error),
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

registerSingleton(IFullCompaction, new SyncDescriptor(FullCompactionService, [], true));
