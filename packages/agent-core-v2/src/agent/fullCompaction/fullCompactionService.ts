import { Disposable } from "#/_base/di/lifecycle";
import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { renderPrompt } from "#/_base/utils/render-prompt";
import {
  estimateTokens,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
} from "#/kosong/contract/tokens";
import { buildCompactionSummaryText, isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { IAgentLLMRequesterService, type AgentLLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { retryBackoffDelays, sleepForRetry } from '#/_base/utils/retry';
import { IAgentLoopService, type LoopErrorContext } from '#/agent/loop/loop';
import { isAbortError } from '#/_base/utils/abort';
import { IAgentProfileService, type ProfileModelContext } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { stripDynamicToolContext } from '#/agent/toolSelect/dynamicTools';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { renderTodoList, type TodoItem } from '#/session/todo/todoItem';
import {
  APIContextOverflowError,
  APIEmptyResponseError,
  APIStatusError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import { createUserMessage, type Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import { inputTotal, type TokenUsage } from '#/kosong/contract/usage';
import { IEventBus } from '#/app/event/eventBus';
import type { CompactionFailedEvent, CompactionFinishedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isCodedError, isError2, toKimiErrorPayload, unwrapErrorCause } from "#/errors";
import { IWireService } from '#/wire/wire';
import compactionInstructionTemplate from './compaction-instruction.md?raw';
import {
  IAgentFullCompactionService,
  type FullCompactionInput,
  type FullCompactionTask,
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
import { Emitter, type Event } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;
const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS = 128 * 1024;
const OVERFLOW_CONTEXT_SAFETY_RATIO = 0.85;
const OVERFLOW_STATUS_RECOVERY_RATIO = 0.5;
const MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS = 3;
const COMPACTION_OVERFLOW_SHRINK_RATIOS = [0.7, 0.5, 0.35] as const;
const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

type CompactionTelemetryProperties = Pick<
  CompactionFinishedEvent,
  'input_tokens' | 'output_tokens' | 'input_cache_read' | 'input_cache_creation'
>;

interface ActiveCompaction extends FullCompactionTask {
  readonly originTurnId?: number;
  trace?: LLMRequestTrace;
  blockedByTurn: boolean;
}

interface CompactionAttemptResult {
  readonly summary: string;
  readonly usage: TokenUsage | null;
  readonly traceId?: string;
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
    onWillCompact: new OrderedHookSlot<FullCompactionTask>(),
  };
  private readonly _onDidFinishCompaction = this._register(new Emitter<FullCompactionTask>());
  readonly onDidFinishCompaction: Event<FullCompactionTask> = this._onDidFinishCompaction.event;

  private readonly strategy: CompactionStrategy;
  private compactionCountInTurn = 0;
  private _compacting: ActiveCompaction | null = null;
  private readonly observedMaxContextTokensByModel = new Map<string, number>();
  private lastCompactedTokenCount: number | null = null;
  private consecutiveOverflowCompactions = 0;
  private activeTurnId: number | undefined;
  private contextInjectorService: IAgentContextInjectorService | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextSizeService private readonly contextSize: IAgentContextSizeService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionTodoService private readonly todo: ISessionTodoService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
    @IAgentLoopService private readonly loopService: IAgentLoopService,
  ) {
    super();
    this.strategy = new RuntimeCompactionStrategy(() => this.resolveModelContextWithEffectiveMax());
    this._register(
      this.wire.hooks.onDidRestore.register('full-compaction', async (_ctx, next) => {
        this.normalizeAfterReplay();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.started', () => this.resetForTurn()),
    );
    this._register(
      this.eventBus.subscribe('turn.ended', () => {
        this.activeTurnId = undefined;
      }),
    );
    this._register(
      this.loopService.hooks.onWillBeginStep.register('full-compaction', async (ctx, next) => {
        await this.beforeStep(ctx.signal, ctx.turnId);
        await next();
      }),
    );
    this._register(
      this.loopService.hooks.onDidFinishStep.register('full-compaction', async (_ctx, next) => {
        await this.afterStep();
        await next();
      }),
    );
    this._register(
      this.loopService.registerLoopErrorHandler({
        id: 'full-compaction',
        match: (context) => this.shouldRecoverFromContextOverflow(context.error),
        handle: (context) => this.recoverFromContextOverflow(context),
      }),
    );
  }

  get compacting(): FullCompactionTask | null {
    return this._compacting;
  }

  private getEffectiveMaxContextTokens(): number {
    const capability = this.profile.data().modelCapabilities;
    const configured = capability.max_input_tokens ?? capability.max_context_tokens;
    const modelAlias = this.profile.data().modelAlias;
    const observed =
      modelAlias === undefined ? undefined : this.observedMaxContextTokensByModel.get(modelAlias);
    if (observed === undefined) return configured;
    if (configured <= 0) return observed;
    return Math.min(configured, observed);
  }

  private resolveModelContextWithEffectiveMax(): ProfileModelContext {
    const resolved = this.profile.resolveModelContext();
    const effectiveMax = this.getEffectiveMaxContextTokens();
    return {
      ...resolved,
      modelCapabilities: {
        ...resolved.modelCapabilities,
        max_context_tokens: effectiveMax,
        max_input_tokens: effectiveMax,
      },
    };
  }

  private estimateCurrentRequestTokens(): number {
    return this.estimateRequestTokens(this.context.get());
  }

  private estimateRequestTokens(messages: readonly Message[]): number {
    return (
      estimateTokens(this.profile.getSystemPrompt()) +
      estimateTokensForTools(this.defaultTools().filter((tool) => tool.deferred !== true)) +
      estimateTokensForMessages(messages)
    );
  }

  private defaultTools(): readonly Tool[] {
    return this.toolSelect
      .shapeTools(this.toolRegistry.list())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
        deferred: tool.deferred,
      }));
  }

  private shouldRecoverFromContextOverflow(
    error: unknown,
    estimatedRequestTokens = this.estimateCurrentRequestTokens(),
  ): boolean {
    if (isCodedError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW) return true;
    const statusError = findAPIStatusError(error);
    if (statusError instanceof APIContextOverflowError) return true;
    if (statusError === undefined || statusError.statusCode !== 413) return false;
    const effectiveMax = this.getEffectiveMaxContextTokens();
    return (
      effectiveMax > 0 &&
      estimatedRequestTokens >= effectiveMax * OVERFLOW_STATUS_RECOVERY_RATIO
    );
  }

  private observeContextOverflow(estimatedRequestTokens: number): void {
    if (!Number.isFinite(estimatedRequestTokens) || estimatedRequestTokens <= 0) return;
    const modelAlias = this.profile.data().modelAlias;
    if (modelAlias === undefined) return;
    const observed = Math.max(
      1,
      Math.floor(estimatedRequestTokens * OVERFLOW_CONTEXT_SAFETY_RATIO),
    );
    const current = this.getEffectiveMaxContextTokens();
    if (current > 0 && observed >= current) return;
    this.observedMaxContextTokensByModel.set(modelAlias, observed);
  }

  begin(input: FullCompactionInput): boolean {
    if (this._compacting) return false;
    const data: CompactionBeginData = { source: input.source, instruction: input.instruction };
    if (!this.reserveCompactionSlot(data.source)) return false;

    const tokenCount = this.validateCompactionStart(data.source);
    this.wire.dispatch(fullCompactionBegin(data));

    const active = this.createActiveCompaction(
      data.source,
      tokenCount,
      data.source === 'auto' ? this.activeTurnId : undefined,
    );
    this._compacting = active.task;
    active.task.abortController.signal.addEventListener(
      'abort',
      () => this.cancelActive(active.task),
      { once: true },
    );
    void this.compactionWorker(active.task, data).then(active.resolve, active.reject);
    void active.task.promise.catch(() => undefined);
    return true;
  }

  private reserveCompactionSlot(source: CompactionBeginData['source']): boolean {
    if (source === 'manual') {
      this.compactionCountInTurn = 0;
    } else {
      this.compactionCountInTurn += 1;
    }
    return this.compactionCountInTurn <= this.strategy.maxCompactionPerTurn;
  }

  private validateCompactionStart(source: CompactionBeginData['source']): number {
    const history = this.context.get();
    if (history.length === 0) {
      throw new Error2(ErrorCodes.COMPACTION_UNABLE, 'No messages to compact in current history.');
    }
    if (source === 'manual' && this.loopService.status().state !== 'idle') {
      throw new Error2(
        ErrorCodes.COMPACTION_UNABLE,
        'Cannot compact while a turn is active. Wait for it to finish, then retry.',
      );
    }
    return estimateTokensForMessages(history);
  }

  private createActiveCompaction(
    trigger: CompactionBeginData['source'],
    tokenCount: number,
    originTurnId: number | undefined,
  ): {
    readonly task: ActiveCompaction;
    readonly resolve: (result: CompactionResult) => void;
    readonly reject: (reason: unknown) => void;
  } {
    const abortController = new AbortController();
    let resolve!: (result: CompactionResult) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<CompactionResult>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return {
      task: {
        abortController,
        promise,
        trigger,
        tokenCount,
        originTurnId,
        get traceId() {
          return this.trace?.traceId;
        },
        blockedByTurn: false,
      },
      resolve,
      reject,
    };
  }

  /** Scope disposal is the fallback abort path; normal agent teardown aborts
   *  and awaits the exposed task before disposing the scope. */
  override dispose(): void {
    if (this._compacting !== null && !this._compacting.abortController.signal.aborted) {
      this._compacting.abortController.abort();
    }
    super.dispose();
  }

  private cancelActive(active: ActiveCompaction): boolean {
    if (this._compacting !== active) return false;
    this.wire.dispatch(fullCompactionCancel({}));
    this._compacting = null;
    if (!active.abortController.signal.aborted) {
      active.abortController.abort();
    }
    this.eventBus.publish({ type: 'compaction.cancelled' });
    return true;
  }

  private markCompleted(active: ActiveCompaction): boolean {
    if (this._compacting !== active) return false;
    this.wire.dispatch(fullCompactionComplete({}));
    this._compacting = null;
    return true;
  }

  private normalizeAfterReplay(): void {
    if (this.wire.getModel(CompactionModel).phase !== 'running') return;
    this.wire.dispatch(fullCompactionCancel({}));
  }

  private resetForTurn(): void {
    this.compactionCountInTurn = 0;
    this.lastCompactedTokenCount = null;
    this.consecutiveOverflowCompactions = 0;
  }

  private async recoverFromContextOverflow(
    context: LoopErrorContext,
  ): Promise<boolean> {
    this.recordOverflowRecovery(context.error);
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this._compacting) return false;

    await this.block(context.signal, context.turnId);
    return this.retryFailedDriver(context);
  }

  private recordOverflowRecovery(error: unknown): void {
    this.observeContextOverflow(this.estimateCurrentRequestTokens());
    this.consecutiveOverflowCompactions += 1;
    const maxAttempts = this.strategy.maxOverflowCompactionAttempts;
    if (this.consecutiveOverflowCompactions <= maxAttempts) return;
    throw new Error2(
      ErrorCodes.CONTEXT_OVERFLOW,
      `Compaction failed to bring the context under the model window after ${String(maxAttempts)} attempts.`,
      { cause: error instanceof Error ? error : undefined },
    );
  }

  private retryFailedDriver(context: LoopErrorContext): boolean {
    const driver = context.failedDriver;
    if (driver === undefined || context.currentStep?.signal.aborted === true) return false;
    context.retry(driver, { at: 'head' });
    return true;
  }

  private async beforeStep(signal: AbortSignal, turnId?: number): Promise<void> {
    this.activeTurnId = turnId;
    this.checkAutoCompaction();
    if (this.strategy.shouldBlock(this.tokenCountWithPending())) {
      await this.block(signal, turnId);
    }
  }

  private async afterStep(): Promise<void> {
    this.consecutiveOverflowCompactions = 0;
    if (this.strategy.checkAfterStep) {
      this.checkAutoCompaction(false);
    }
  }

  private checkAutoCompaction(throwOnLimit = true): boolean {
    if (this._compacting) return true;
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
    if (this._compacting) return true;
    const maxCompactions = this.strategy.maxCompactionPerTurn;
    if (this.compactionCountInTurn >= maxCompactions) {
      if (throwOnLimit) {
        throw new Error2(ErrorCodes.CONTEXT_OVERFLOW, `Compaction limit exceeded (${String(maxCompactions)})`, {
          details: { maxCompactions },
        });
      }
      return false;
    }
    return this.begin({ source: 'auto' });
  }

  private async block(signal?: AbortSignal, turnId?: number): Promise<void> {
    const active = this._compacting;
    if (active === null) return;
    active.blockedByTurn = true;
    this.propagateBlockingAbort(active, signal);
    this.eventBus.publish({ type: 'compaction.blocked', turnId });
    try {
      await active.promise;
    } catch (error) {
      if (this.wasBlockingWaitAborted(active, signal, error)) return;
      throw error;
    }
  }

  private propagateBlockingAbort(active: ActiveCompaction, signal: AbortSignal | undefined): void {
    signal?.addEventListener(
      'abort',
      () => {
        if (this._compacting === active) active.abortController.abort();
      },
      { once: true },
    );
  }

  private wasBlockingWaitAborted(
    active: ActiveCompaction,
    signal: AbortSignal | undefined,
    error: unknown,
  ): boolean {
    return (
      signal?.aborted === true &&
      (active.abortController.signal.aborted || isAbortError(error))
    );
  }

  private async compactionWorker(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
  ): Promise<CompactionResult> {
    try {
      const result = await this.compactionRound(active, data);
      if (this._compacting !== active) throw compactionCancelledReason(active);
      try {
        await this.profile.refreshSystemPrompt();
      } catch (error) {
        this.log.error('failed to refresh system prompt after compaction', { error });
      }
      this.lastCompactedTokenCount = result.tokensAfter;
      await this.contextInjector.injectAfterCompaction();
      this.lastCompactedTokenCount = this.tokenCountWithPending();
      if (!this.markCompleted(active)) {
        throw compactionCancelledReason(active);
      }
      const { contextSummary: _contextSummary, ...eventResult } = result;
      void _contextSummary;
      this.eventBus.publish({ type: 'compaction.completed', result: eventResult });
      return result;
    } catch (error) {
      if (active.abortController.signal.aborted || isAbortError(error)) {
        this.cancelActive(active);
        throw error;
      }
      const blockedByTurn = this._compacting === active && active.blockedByTurn;
      if (this._compacting === active) {
        this.cancelActive(active);
      }
      if (blockedByTurn) {
        throw error;
      }
      this.eventBus.publish({
        type: 'error',
        ...toKimiErrorPayload(error),
      });
      throw error;
    } finally {
      this._onDidFinishCompaction.fire(active);
    }
  }

  private async compactionRound(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
  ): Promise<CompactionResult> {
    const startedAt = Date.now();
    const originalHistory = [...this.context.get()];
    const tokensBefore = estimateTokensForMessages(originalHistory);
    let retryCount = 0;
    let thinkingEffort = this.profile.data().thinkingLevel;

    try {
      const signal = active.abortController.signal;
      signal.throwIfAborted();

      await this.hooks.onWillCompact.run(active);

      const resolvedModel = this.profile.resolveModelContext();
      thinkingEffort = resolvedModel.thinkingLevel;
      const maxContextTokens = resolvedModel.modelCapabilities.max_context_tokens;
      const defaultCompactionCap =
        maxContextTokens > 0
          ? Math.min(maxContextTokens, DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS)
          : undefined;
      const compactionMaxOutputSize = resolvedModel.maxOutputSize ?? defaultCompactionCap;

      const customInstruction = data.instruction?.trim() ?? '';
      const instruction = renderPrompt(compactionInstructionTemplate, {
        custom_instruction_block:
          customInstruction.length > 0 ? `\nOptional user instruction:\n${customInstruction}\n` : '',
      }).trimEnd();

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      let attempt: CompactionAttemptResult | undefined;
      let historyForModel: readonly ContextMessage[] = stripDynamicToolContext(originalHistory);
      let droppedCount = 0;
      let overflowShrinkCount = 0;
      let emptyOrTruncatedShrinkCount = 0;
      while (true) {
        const messagesToCompact = historyForModel;
        const messages: Message[] = [...messagesToCompact, createUserMessage(instruction)];
        const estimatedCompactionRequestTokens = this.estimateRequestTokens(messages);

        try {
          const request = this.llmRequester.start(
            {
              messages,
              maxOutputSize: compactionMaxOutputSize,
              source: {
                type: 'operation',
                turnId: active.originTurnId,
                requestKind: 'full_compaction',
                logFields: { droppedCount },
              },
            },
            undefined,
            signal,
          );
          active.trace = request.trace;
          attempt = collectSummary(await request.result);
          break;
        } catch (error) {
          const isContextOverflow = this.shouldRecoverFromContextOverflow(
            error,
            estimatedCompactionRequestTokens,
          );
          if (isContextOverflow) {
            this.observeContextOverflow(estimatedCompactionRequestTokens);
            overflowShrinkCount += 1;
            if (
              overflowShrinkCount > MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS ||
              messagesToCompact.length <= 1
            ) {
              throw error;
            }
            const before = messagesToCompact.length;
            historyForModel = shrinkCompactionHistoryAfterOverflow(
              messagesToCompact,
              overflowShrinkCount,
            );
            droppedCount += before - historyForModel.length;
            retryCount = 0;
            continue;
          }
          if (
            (error instanceof CompactionTruncatedError || unwrapErrorCause(error) instanceof APIEmptyResponseError) &&
            messagesToCompact.length > 1
          ) {
            emptyOrTruncatedShrinkCount += 1;
            if (emptyOrTruncatedShrinkCount > MAX_COMPACTION_RETRY_ATTEMPTS) {
              throw error;
            }
            const reduced = dropOldestMessageAndLeadingToolResults(messagesToCompact);
            droppedCount += messagesToCompact.length - reduced.length;
            historyForModel = reduced;
            retryCount = 0;
            continue;
          }
          if (!isRetryableGenerateError(unwrapErrorCause(error))) {
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

      if (!historySafeToCompact(this.context.get(), originalHistory)) {
        const active = this._compacting;
        if (active !== null) {
          this.cancelActive(active);
        }
        throw compactionCancelledReason(active);
      }

      const summary = this.postProcessSummary(attempt.summary);
      const result = this.context.applyCompaction({
        summary,
        contextSummary: buildCompactionSummaryText(summary),
        compactedCount: originalHistory.length,
        tokensBefore,
        droppedCount: droppedCount === 0 ? undefined : droppedCount,
      });

      const properties: CompactionFinishedEvent = {
        turn_id: active.originTurnId,
        source: data.source,
        tokens_before: result.tokensBefore,
        tokens_after: result.tokensAfter,
        duration_ms: Date.now() - startedAt,
        compacted_count: result.compactedCount,
        dropped_count: result.droppedCount,
        retry_count: retryCount,
        round: 1,
        thinking_effort: thinkingEffort,
        trace_id: attempt.traceId,
        ...usageTelemetry(attempt.usage),
      };
      this.telemetry.track2('compaction_finished', properties);
      return result;
    } catch (error) {
      if (isAbortError(error)) throw error;
      const properties: CompactionFailedEvent = {
        turn_id: active.originTurnId,
        source: data.source,
        tokens_before: tokensBefore,
        duration_ms: Date.now() - startedAt,
        round: 1,
        retry_count: retryCount,
        thinking_effort: thinkingEffort,
        error_type: error instanceof Error ? error.name : 'Unknown',
        trace_id: findAPIStatusError(error)?.traceId ?? active.traceId,
      };
      this.telemetry.track2('compaction_failed', properties);
      if (
        isError2(error) &&
        (error.code === ErrorCodes.AUTH_LOGIN_REQUIRED ||
          error.code === ErrorCodes.PROVIDER_AUTH_ERROR)
      ) {
        throw error;
      }
      throw new Error2(ErrorCodes.COMPACTION_FAILED, String(error), { cause: error });
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
    return this.contextSize.get().size;
  }

  private get contextInjector(): IAgentContextInjectorService {
    if (this.contextInjectorService === undefined) {
      this.contextInjectorService = this.instantiation.invokeFunction((accessor) =>
        accessor.get(IAgentContextInjectorService),
      );
    }
    return this.contextInjectorService;
  }
}

function findAPIStatusError(error: unknown): APIStatusError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof APIStatusError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function collectSummary(finish: AgentLLMRequestFinish): CompactionAttemptResult {
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

  return { summary, usage: finish.usage, traceId: finish.traceId };
}

function historySafeToCompact(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  if (current.length < original.length) return false;
  if (!original.every((message, index) => message === current[index])) return false;
  return current.slice(original.length).every(isRealUserInput);
}

function shrinkCompactionHistoryAfterOverflow<T extends Message>(
  messages: readonly T[],
  attempt: number,
): T[] {
  if (messages.length <= 1) return messages.slice();
  const ratio = COMPACTION_OVERFLOW_SHRINK_RATIOS[
    Math.min(attempt - 1, COMPACTION_OVERFLOW_SHRINK_RATIOS.length - 1)
  ]!;
  const tokenBudget = Math.floor(estimateTokensForMessages(messages) * ratio);
  return takeRecentMessagesWithinTokenBudget(messages, tokenBudget);
}

function takeRecentMessagesWithinTokenBudget<T extends Message>(
  messages: readonly T[],
  tokenBudget: number,
): T[] {
  let start = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateTokensForMessage(messages[i]!);
    if (tokens + messageTokens > tokenBudget) break;
    tokens += messageTokens;
    start = i;
  }
  if (start === 0) start = 1;
  return dropLeadingToolResults(messages.slice(start));
}

function dropOldestMessageAndLeadingToolResults<T extends { readonly role: string }>(
  messages: readonly T[],
): T[] {
  if (messages.length <= 1) return messages.slice();
  return dropLeadingToolResults(messages.slice(1));
}

function dropLeadingToolResults<T extends { readonly role: string }>(messages: readonly T[]): T[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role === 'tool') {
    start += 1;
  }
  return messages.slice(start);
}

function usageTelemetry(usage: TokenUsage | null): CompactionTelemetryProperties {
  if (usage === null) return {};
  return {
    input_tokens: inputTotal(usage),
    output_tokens: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}

function compactionCancelledReason(active: ActiveCompaction | null): Error {
  const reason = active?.abortController.signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Compaction cancelled.');
  error.name = 'AbortError';
  return error;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentFullCompactionService,
  AgentFullCompactionService,
  InstantiationType.Eager,
  'fullCompaction',
);
