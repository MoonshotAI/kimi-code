import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { renderPrompt } from "#/_base/utils/render-prompt";
import {
  APIContextOverflowError,
  APIEmptyResponseError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import { createUserMessage, type Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import { retryBackoffDelays, sleepForRetry } from '#/_base/utils/retry';
import { isAbortError } from '#/_base/utils/abort';
import { Emitter, type Event } from '#/_base/event';
import { OrderedHookSlot } from '#/hooks';
import { buildCompactionSummaryText } from '#/features/contextMemory/compactionHandoff';
import { AgentContextMemory, type ContextMemoryRuntime } from '#/features/contextMemory/contextMemoryAgentRuntime';
import type { ContextMessage } from '#/features/contextMemory/types';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import {
  AgentLlmRequester,
  type LlmRequesterRuntime,
} from '#/features/llmRequester/llmRequesterAgentRuntime';
import { getLoopControl } from '#/features/loop/internal/access';
import { IAgentHostService } from '#/agent/host/agentHost';
import type { LoopErrorContext } from '#/features/loop/internal/loop';
import { TurnStarted } from '#/features/loop/turnEvents';
import { TurnEnded } from '#/features/loop/turnOps';
import { AgentProfile, type ProfileRuntime } from '#/features/profile/profileAgentRuntime';
import { type ProfileModelContext } from '#/features/profile/profile';
import { stripDynamicToolContext } from '#/agent/toolSelect/dynamicTools';
import { AgentTools } from '#/features/toolExecutor/toolExecutorAgentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentTodo, type TodoRuntime } from '#/features/todo/todoAgentRuntime';
import { renderTodoList } from '#/features/todo/todoItem';
import type { CompactionFailedEvent, CompactionFinishedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isCodedError, isError2, toKimiErrorPayload, unwrapErrorCause } from "#/errors";
import { AgentErrorEvent } from '#/app/event/agentEvents';
import type { AgentEvent2 } from '#/app/event/event2';
import type { AgentRuntimeContext, AgentRuntimeRestoreEvent } from '#/agent/runtime/agentRuntime';
import { ulid } from 'ulid';
import compactionInstructionTemplate from '../compaction-instruction.md?raw';
import {
  type FullCompactionBeginInput,
  type FullCompactionHookContext,
  type FullCompactionStatus,
  type FullCompactionTask,
} from '../fullCompactionAgentRuntime';
import {
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
  type CompactionState,
} from '../compactionOps';
import { CompactionBlocked, CompactionCancelled, CompactionCompleted } from '../fullCompactionEvents';
import { RuntimeCompactionStrategy, type CompactionStrategy } from './strategy';
import {
  type ActiveCompaction,
  type CompactionAttemptResult,
  collectSummary,
  compactionCancelledReason,
  CompactionTruncatedError,
  dropOldestMessageAndLeadingToolResults,
  findAPIStatusError,
  historySafeToCompact,
  shrinkCompactionHistoryAfterOverflow,
  usageTelemetry,
} from './compactionHelpers';
import type { CompactionBeginData, CompactionResult } from '../types';

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;
const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS = 128 * 1024;
const OVERFLOW_CONTEXT_SAFETY_RATIO = 0.85;
const OVERFLOW_STATUS_RECOVERY_RATIO = 0.5;
const MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS = 3;
const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

function newCompactionId(): string {
  return `compaction_${ulid()}`;
}

export class FullCompactionDomain {
  private readonly _onDidFinish = new Emitter<FullCompactionTask>();
  readonly onDidFinish: Event<FullCompactionTask> = this._onDidFinish.event;
  private readonly beforeCompactHooks = new OrderedHookSlot<FullCompactionHookContext>();

  private readonly strategy: CompactionStrategy;
  private _compacting: ActiveCompaction | null = null;
  private lastOutcome: FullCompactionStatus | undefined;
  private compactionCountInTurn = 0;
  private readonly observedMaxContextTokensByModel = new Map<string, number>();
  lastCompactedTokenCount: number | null = null;
  private consecutiveOverflowCompactions = 0;
  private activeTurnId: number | undefined;
  private stopped = false;

  constructor(private readonly runtime: AgentRuntimeContext<CompactionState>) {
    this.strategy = new RuntimeCompactionStrategy(
      () => this.resolveModelContextWithEffectiveMax(),
      (message) => this.tokenCounting.estimateMessage(message),
    );
  }

  private get agentId(): string {
    return this.runtime.agent.agentId;
  }

  private dispatch(event: AgentEvent2<any>): void {
    if (this.stopped) return;
    void this.runtime.dispatch(event);
  }

  private get tokenCounting(): ISessionTokenCountingService {
    return this.runtime.get(ISessionTokenCountingService);
  }

  private get telemetry(): ITelemetryService {
    return this.runtime.get(IAgentHostService).of(this.runtime.agent).telemetry;
  }

  private get manager(): IAgentLifecycleService {
    return this.runtime.get(IAgentLifecycleService);
  }

  private get profile(): ProfileRuntime {
    return this.manager.resolve(this.runtime.agent, AgentProfile);
  }

  private get todo(): TodoRuntime {
    return this.manager.resolve(this.runtime.agent, AgentTodo);
  }

  private get context(): ContextMemoryRuntime {
    return this.manager.resolve(this.runtime.agent, AgentContextMemory);
  }

  private get llmRequester(): LlmRequesterRuntime {
    return this.manager.resolve(this.runtime.agent, AgentLlmRequester);
  }

  attach(): IDisposable {
    const loop = getLoopControl(this.runtime.agent);
    const eventBus = this.runtime.get(IAgentHostService).of(this.runtime.agent).eventBus;
    const registrations: IDisposable[] = [
      eventBus.subscribe(TurnStarted, () => this.resetForTurn()),
      eventBus.subscribe(TurnEnded, () => {
        this.activeTurnId = undefined;
      }),
      loop.hooks.onWillBeginStep.register('full-compaction', async (ctx, next) => {
        await this.beforeStep(ctx.signal, ctx.turnId);
        await next();
      }),
      loop.hooks.onDidFinishStep.register('full-compaction', async (_ctx, next) => {
        await this.afterStep();
        await next();
      }),
      loop.registerLoopErrorHandler({
        id: 'full-compaction',
        match: (context) => this.shouldRecoverFromContextOverflow(context.error),
        handle: (context) => this.recoverFromContextOverflow(context),
      }),
    ];
    return toDisposable(() => {
      this.stopped = true;
      for (const registration of registrations.splice(0)) registration.dispose();
      const active = this._compacting;
      if (active !== null && !active.abortController.signal.aborted) {
        active.abortController.abort();
      }
    });
  }

  registerBeforeCompactHook(
    name: string,
    hook: (ctx: FullCompactionHookContext) => Promise<void>,
  ): IDisposable {
    return this.beforeCompactHooks.register(name, async (ctx, next) => {
      await hook(ctx);
      await next();
    });
  }

  status(): FullCompactionStatus {
    if (this._compacting !== null) return 'running';
    if (this.runtime.getState().phase === 'running') return 'running';
    return this.lastOutcome ?? 'idle';
  }

  async begin(input: FullCompactionBeginInput = {}): Promise<FullCompactionTask> {
    return this.taskOf(this.beginNow(input));
  }

  private beginNow(input: FullCompactionBeginInput): ActiveCompaction {
    const current = this._compacting;
    if (current !== null) return current;
    const data: CompactionBeginData = {
      source: input.source ?? 'manual',
      instruction: input.instruction,
    };
    if (!this.reserveCompactionSlot(data.source)) {
      throw new Error2(
        ErrorCodes.COMPACTION_UNABLE,
        `Compaction limit exceeded (${String(this.strategy.maxCompactionPerTurn)})`,
      );
    }

    const tokenCount = this.validateCompactionStart(data.source);
    const quiescence = data.source === 'manual'
      ? getLoopControl(this.runtime.agent).tryAcquireQuiescence()
      : undefined;
    if (data.source === 'manual' && quiescence === undefined) {
      throw new Error2(
        ErrorCodes.COMPACTION_UNABLE,
        'Cannot compact while a turn is active or another context change is running. Wait for it to finish, then retry.',
      );
    }
    try {
      this.dispatch(new FullCompactionBegin({ ...data, agentId: this.agentId }));

      const { task: active, resolve, reject } = this.createActiveCompaction(
        data.source,
        tokenCount,
        data.source === 'auto' ? this.activeTurnId : undefined,
        quiescence,
      );
      this._compacting = active;
      active.abortController.signal.addEventListener(
        'abort',
        () => this.cancelActive(active),
        { once: true },
      );
      void this.compactionWorker(active, data).then(resolve, reject);
      void active.promise.catch(() => undefined);
      return active;
    } catch (error) {
      quiescence?.dispose();
      throw error;
    }
  }

  private taskOf(active: ActiveCompaction): FullCompactionTask {
    return {
      get id() { return active.id; },
      get status(): FullCompactionStatus {
        return active.outcome ?? 'running';
      },
    };
  }

  async cancel(): Promise<void> {
    const active = this._compacting;
    if (active === null) return;
    this.telemetry.track2('cancel', {
      from: 'compacting',
      trace_id: active.traceId,
    });
    if (!active.abortController.signal.aborted) {
      active.abortController.abort();
    }
    await active.promise.catch(() => undefined);
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
    const resolved = this.profile.modelContext();
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

  private currentRequestTokens(): number {
    return this.requestTokens(this.context.get());
  }

  private requestTokens(messages: readonly Message[]): number {
    return this.tokenCounting.requestSize({
      systemPrompt: this.profile.systemPrompt(),
      tools: this.defaultTools().filter((tool) => tool.deferred !== true),
      messages,
    });
  }

  private defaultTools(): readonly Tool[] {
    return this.runtime
      .get(IAgentLifecycleService)
      .resolve(this.runtime.agent, AgentTools)
      .toolsForModel()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
        deferred: tool.deferred,
      }));
  }

  private shouldRecoverFromContextOverflow(
    error: unknown,
    estimatedRequestTokens = this.currentRequestTokens(),
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
    if (source === 'manual' && getLoopControl(this.runtime.agent).status().state !== 'idle') {
      throw new Error2(
        ErrorCodes.COMPACTION_UNABLE,
        'Cannot compact while a turn is active. Wait for it to finish, then retry.',
      );
    }
    return this.requestTokens(history);
  }

  private createActiveCompaction(
    trigger: CompactionBeginData['source'],
    tokenCount: number,
    originTurnId: number | undefined,
    quiescence: IDisposable | undefined,
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
        id: newCompactionId(),
        abortController,
        promise,
        trigger,
        tokenCount,
        originTurnId,
        quiescence,
        get traceId() {
          return this.trace?.traceId;
        },
        outcome: undefined,
        blockedByTurn: false,
      },
      resolve,
      reject,
    };
  }

  private cancelActive(active: ActiveCompaction): boolean {
    if (this._compacting !== active) return false;
    this._compacting = null;
    active.outcome = 'cancelled';
    this.lastOutcome = 'cancelled';
    this.dispatch(new FullCompactionCancel({ agentId: this.agentId }));
    if (!active.abortController.signal.aborted) {
      active.abortController.abort();
    }
    this.dispatch(new CompactionCancelled({ agentId: this.agentId }));
    return true;
  }

  private markCompleted(active: ActiveCompaction): boolean {
    if (this._compacting !== active) return false;
    this._compacting = null;
    active.outcome = 'completed';
    this.lastOutcome = 'completed';
    this.dispatch(new FullCompactionComplete({ agentId: this.agentId }));
    return true;
  }

  normalizeAfterReplay(event: AgentRuntimeRestoreEvent): void {
    if (this.runtime.getState().phase !== 'running') return;
    event.waitUntil(
      this.runtime.dispatch(new FullCompactionCancel({ agentId: this.agentId })),
    );
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
    this.observeContextOverflow(this.currentRequestTokens());
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
    this.beginNow({ source: 'auto' });
    return true;
  }

  private async block(signal?: AbortSignal, turnId?: number): Promise<void> {
    const active = this._compacting;
    if (active === null) return;
    active.blockedByTurn = true;
    this.propagateBlockingAbort(active, signal);
    this.dispatch(new CompactionBlocked({ agentId: this.agentId, turnId }));
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
      this.lastCompactedTokenCount = result.tokensAfter;
      if (!this.markCompleted(active)) {
        throw compactionCancelledReason(active);
      }
      const { contextSummary: _contextSummary, ...eventResult } = result;
      void _contextSummary;
      this.dispatch(
        new CompactionCompleted({ agentId: this.agentId, result: eventResult }),
      );
      return result;
    } catch (error) {
      if (active.abortController.signal.aborted || isAbortError(error)) {
        this.cancelActive(active);
        throw error;
      }
      const blockedByTurn = this._compacting === active && active.blockedByTurn;
      if (this._compacting === active) {
        this.cancelActive(active);
        active.outcome = 'failed';
        this.lastOutcome = 'failed';
      }
      if (blockedByTurn) {
        throw error;
      }
      this.dispatch(
        new AgentErrorEvent({ ...toKimiErrorPayload(error), agentId: this.agentId }),
      );
      throw error;
    } finally {
      try {
        this._onDidFinish.fire(this.taskOf(active));
      } finally {
        active.quiescence?.dispose();
      }
    }
  }

  private async compactionRound(
    active: ActiveCompaction,
    data: Readonly<CompactionBeginData>,
  ): Promise<CompactionResult> {
    const startedAt = Date.now();
    const originalHistory = [...this.context.get()];
    const tokensBefore = this.requestTokens(originalHistory);
    let retryCount = 0;
    let thinkingEffort = this.profile.data().thinkingLevel;

    try {
      const signal = active.abortController.signal;
      signal.throwIfAborted();

      await this.beforeCompactHooks.run({
        trigger: active.trigger,
        tokenCount: active.tokenCount,
        signal,
        settlement: active.promise,
      });

      const resolvedModel = this.profile.modelContext();
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
        const estimatedCompactionRequestTokens = this.requestTokens(messages);

        try {
          const request = this.llmRequester.stream(
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
              (message) => this.tokenCounting.estimateMessage(message),
            );
            droppedCount += before - historyForModel.length;
            retryCount = 0;
            continue;
          }
          const unwrappedError = unwrapErrorCause(error);
          if (
            (error instanceof CompactionTruncatedError ||
              (unwrappedError instanceof APIEmptyResponseError &&
                unwrappedError.finishReason !== 'filtered')) &&
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
          if (!isRetryableGenerateError(unwrappedError)) {
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

      const summary = await this.postProcessSummary(attempt.summary);
      const result = await this.context.applyCompaction({
        summary,
        contextSummary: buildCompactionSummaryText(summary),
        compactedCount: originalHistory.length,
        tokensBefore,
        summaryOutputTokens: attempt.usage?.output,
        requestOverheadTokens: this.requestTokens([]),
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

  private async postProcessSummary(summary: string): Promise<string> {
    const todos = this.todo.get();
    if (todos.length === 0) {
      return summary;
    }
    return `${summary.trim()}\n\n${renderTodoList(todos, '## TODO List')}`;
  }

  private tokenCountWithPending(): number {
    return this.tokenCounting.get(this.runtime.agent).size;
  }
}
