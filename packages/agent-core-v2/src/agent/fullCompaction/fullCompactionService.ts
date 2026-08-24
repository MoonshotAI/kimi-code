import type { IDisposable } from '#/_base/di/lifecycle';
import { Service } from "#/_base/di/service";
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/state/state';
import { renderPrompt } from "#/_base/utils/render-prompt";
import {
  estimateTokensForMessage,
  estimateTokensForMessages,
} from "#/kosong/contract/tokens";
import {
  buildCompactionSummaryText,
  createCompactionSummaryMessage,
  isRealUserInput,
} from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { IAgentSpineService } from '#/agent/spine/spine';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IAgentLLMRequesterService, type AgentLLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { retryBackoffDelays, sleepForRetry } from '#/_base/utils/retry';
import { IAgentLoopService, type AfterStepContext, type LoopErrorContext } from '#/agent/loop/loop';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { isAbortError } from '#/_base/utils/abort';
import {
  IAgentProfileService,
  type ProfileModelContext,
  type WillSetModelContext,
} from '#/agent/profile/profile';
import {
  agentContextOfScope,
  IAgentScopeContext,
} from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { stripDynamicToolContext } from '#/agent/toolSelect/dynamicTools';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentTodo, type TodoRuntime } from '#/features/todo/todoAgentRuntime';
import { renderTodoList, type TodoItem } from '#/features/todo/todoItem';
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
import { IFlagService } from '#/app/flag/flag';
import type { CompactionFailedEvent, CompactionFinishedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2, isCodedError, isError2, toKimiErrorPayload, unwrapErrorCause } from "#/errors";
import { AgentErrorEvent } from '#/agent/mcp/mcpEvents';
import { IEventDispatcher } from '#/state/eventDispatcher';
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
  CompactionBlocked,
  CompactionCancelled,
  CompactionCompleted,
  fullCompactionKey,
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
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

type CompactionCancelReason = 'abort' | 'history_changed';

interface ActiveCompaction extends FullCompactionTask {
  readonly originTurnId?: number;
  readonly quiescence?: IDisposable;
  trace?: LLMRequestTrace;
  blockedByTurn: boolean;
  cancelReason?: CompactionCancelReason;
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

export const fullCompactionCompactionCountInTurnKey = defineState<number>(
  'fullCompaction.compactionCountInTurn',
  () => 0,
);
export const fullCompactionObservedMaxContextTokensByModelKey = defineState<Map<string, number>>(
  'fullCompaction.observedMaxContextTokensByModel',
  () => new Map(),
);
export const fullCompactionLastCompactedTokenCountKey = defineState<number | null>(
  'fullCompaction.lastCompactedTokenCount',
  () => null,
);
export const fullCompactionConsecutiveOverflowCompactionsKey = defineState<number>(
  'fullCompaction.consecutiveOverflowCompactions',
  () => 0,
);
export const fullCompactionActiveTurnIdKey = defineState<number | undefined>(
  'fullCompaction.activeTurnId',
  () => undefined as number | undefined,
);

export class AgentFullCompactionService extends Service implements IAgentFullCompactionService {
  declare readonly _serviceBrand: undefined;
  readonly hooks: IAgentFullCompactionService['hooks'] = {
    onWillCompact: new OrderedHookSlot<FullCompactionTask>(),
  };
  private readonly _onDidFinishCompaction = this._register(new Emitter<FullCompactionTask>());
  readonly onDidFinishCompaction: Event<FullCompactionTask> = this._onDidFinishCompaction.event;

  private readonly strategy: CompactionStrategy;
  private readonly todo: TodoRuntime;
  private _compacting: ActiveCompaction | null = null;
  private compactionFutile = false;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentSpineService private readonly spine: IAgentSpineService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentLifecycleService manager: IAgentLifecycleService,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IEventBus private readonly eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.todo = manager.resolve(agent.agentContext, AgentTodo);
    this.states.contributeState(fullCompactionKey);
    this.states.contributeState(fullCompactionCompactionCountInTurnKey);
    this.states.contributeState(fullCompactionObservedMaxContextTokensByModelKey);
    this.states.contributeState(fullCompactionLastCompactedTokenCountKey);
    this.states.contributeState(fullCompactionConsecutiveOverflowCompactionsKey);
    this.states.contributeState(fullCompactionActiveTurnIdKey);
    this.strategy = new RuntimeCompactionStrategy(
      () => this.resolveModelContextWithEffectiveMax(),
      (message) => this.tokenCounting.estimateMessage(message),
    );
    this._register(
      this.dispatcher.hooks.onDidRestore.register('full-compaction', async (_ctx, next) => {
        this.normalizeAfterReplay();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe(TurnStarted, () => this.resetForTurn()),
    );
    this._register(
      this.eventBus.subscribe(ContextSpliced, (event) => {
        if (event.deleteCount === 0) return;
        this.lastCompactedTokenCount = null;
        this.compactionFutile = false;
      }),
    );
    this._register(
      this.eventBus.subscribe(TurnEnded, () => {
        this.activeTurnId = undefined;
      }),
    );
    this._register(
      this.profile.hooks.onWillSetModel.register('full-compaction', async (ctx, next) => {
        await this.preCompactForModelDownshift(ctx);
        await next();
      }),
    );
    this._register(
      this.loopService.hooks.onWillBeginStep.register('full-compaction', async (ctx, next) => {
        await this.beforeStep(ctx.signal, ctx.turnId);
        await next();
      }),
    );
    this._register(
      this.loopService.hooks.onDidFinishStep.register('full-compaction', async (ctx, next) => {
        await this.afterStep(ctx);
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

  private get compactionCountInTurn(): number {
    return this.states.get(fullCompactionCompactionCountInTurnKey);
  }

  private set compactionCountInTurn(value: number) {
    this.states.set(fullCompactionCompactionCountInTurnKey, value);
  }

  private get lastCompactedTokenCount(): number | null {
    return this.states.get(fullCompactionLastCompactedTokenCountKey);
  }

  private set lastCompactedTokenCount(value: number | null) {
    this.states.set(fullCompactionLastCompactedTokenCountKey, value);
  }

  private get consecutiveOverflowCompactions(): number {
    return this.states.get(fullCompactionConsecutiveOverflowCompactionsKey);
  }

  private set consecutiveOverflowCompactions(value: number) {
    this.states.set(fullCompactionConsecutiveOverflowCompactionsKey, value);
  }

  private get activeTurnId(): number | undefined {
    return this.states.get(fullCompactionActiveTurnIdKey);
  }

  private set activeTurnId(value: number | undefined) {
    this.states.set(fullCompactionActiveTurnIdKey, value);
  }

  get compacting(): FullCompactionTask | null {
    return this._compacting;
  }

  cancel(): void {
    const active = this._compacting;
    if (active !== null) {
      this.telemetry.track2('cancel', {
        from: 'compacting',
        trace_id: active.traceId,
      });
    }
    active?.abortController.abort();
  }

  private resolveModelContextWithEffectiveMax(): ProfileModelContext {
    const resolved = this.profile.resolveModelContext();
    const effectiveMax = this.profile.getEffectiveMaxContextTokens();
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
    return (
      this.requestOverheadTokens() +
      this.projector.estimateProjectedTokens(this.context.get())
    );
  }

  private requestTokens(messages: readonly Message[]): number {
    return this.requestOverheadTokens() + this.tokenCounting.estimateMessages(messages);
  }

  private requestOverheadTokens(): number {
    return this.tokenCounting.requestSize({
      systemPrompt: this.profile.getSystemPrompt(),
      tools: this.defaultTools().filter((tool) => tool.deferred !== true),
      messages: [],
    });
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
    estimatedRequestTokens = this.currentRequestTokens(),
  ): boolean {
    if (isCodedError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW) return true;
    const statusError = findAPIStatusError(error);
    if (statusError instanceof APIContextOverflowError) return true;
    if (statusError === undefined || statusError.statusCode !== 413) return false;
    const effectiveMax = this.profile.getEffectiveMaxContextTokens();
    return (
      effectiveMax > 0 &&
      estimatedRequestTokens >= effectiveMax * OVERFLOW_STATUS_RECOVERY_RATIO
    );
  }

  private observeContextOverflow(estimatedRequestTokens: number): void {
    if (!Number.isFinite(estimatedRequestTokens) || estimatedRequestTokens <= 0) return;
    const observed = Math.max(
      1,
      Math.floor(estimatedRequestTokens * OVERFLOW_CONTEXT_SAFETY_RATIO),
    );
    this.profile.observeMaxContextTokens(observed);
  }

  begin(input: FullCompactionInput): boolean {
    if (this._compacting) return false;
    const data: CompactionBeginData = { source: input.source, instruction: input.instruction };
    if (!this.reserveCompactionSlot(data.source)) return false;

    const tokenCount = this.validateCompactionStart(data.source);
    const quiescence = data.source === 'manual'
      ? this.loopService.tryAcquireQuiescence()
      : undefined;
    if (data.source === 'manual' && quiescence === undefined) {
      throw new Error2(
        ErrorCodes.COMPACTION_UNABLE,
        'Cannot compact while a turn is active or another context change is running. Wait for it to finish, then retry.',
      );
    }
    try {
      void this.dispatcher.dispatch(
        new FullCompactionBegin({ ...data, agentId: this.agent.agentId }),
      );

      const active = this.createActiveCompaction(
        data.source,
        tokenCount,
        data.source === 'auto' ? this.activeTurnId : undefined,
        quiescence,
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
    } catch (error) {
      quiescence?.dispose();
      throw error;
    }
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
        abortController,
        promise,
        trigger,
        tokenCount,
        originTurnId,
        quiescence,
        get traceId() {
          return this.trace?.traceId;
        },
        blockedByTurn: false,
      },
      resolve,
      reject,
    };
  }

  override dispose(): void {
    if (this._compacting !== null && !this._compacting.abortController.signal.aborted) {
      this._compacting.abortController.abort();
    }
    super.dispose();
  }

  private cancelActive(active: ActiveCompaction, reason: CompactionCancelReason = 'abort'): boolean {
    if (this._compacting !== active) return false;
    active.cancelReason ??= reason;
    void this.dispatcher.dispatch(new FullCompactionCancel({ agentId: this.agent.agentId }));
    this._compacting = null;
    if (!active.abortController.signal.aborted) {
      active.abortController.abort();
    }
    void this.dispatcher.dispatch(new CompactionCancelled({ agentId: this.agent.agentId }));
    return true;
  }

  private markCompleted(active: ActiveCompaction): boolean {
    if (this._compacting !== active) return false;
    void this.dispatcher.dispatch(new FullCompactionComplete({ agentId: this.agent.agentId }));
    this._compacting = null;
    return true;
  }

  private normalizeAfterReplay(): void {
    if (this.states.get(fullCompactionKey).phase !== 'running') return;
    void this.dispatcher.dispatch(new FullCompactionCancel({ agentId: this.agent.agentId }));
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

  /**
   * `profile.onWillSetModel` handler: switching to a model whose window is
   * smaller than the live context would make the next step overflow and force
   * the compaction summary request itself through the overflow-shrink ladder
   * against the smaller window. Compact instead while the outgoing
   * (larger-window) model is still the active provider, so the summary covers
   * the full history in one shot. Failures here must not veto the switch —
   * the next step's overflow recovery remains as the fallback.
   */
  private async preCompactForModelDownshift(context: WillSetModelContext): Promise<void> {
    if (this._compacting !== null) return;
    if (this.loopService.status().state === 'running') return;
    if (this.context.get().length === 0) return;
    const nextMax = context.nextMaxContextTokens;
    if (nextMax === undefined || nextMax <= 0) return;
    const currentMax = this.profile.getEffectiveMaxContextTokens();
    if (nextMax !== currentMax) {
      this.lastCompactedTokenCount = null;
      this.compactionFutile = false;
    }
    if (nextMax >= currentMax) return;
    if (!this.strategy.shouldCompactForWindow(this.tokenCountWithPending(), nextMax)) return;
    this.begin({ source: 'auto' });
    try {
      await this.block();
    } catch (error) {
      this.log.warn('Pre-compaction before model downshift failed; switching model anyway.', {
        error,
      });
    }
  }

  private async afterStep(context: AfterStepContext): Promise<void> {
    this.consecutiveOverflowCompactions = 0;
    if (this.strategy.checkAfterStep && context.finishReason === 'tool_calls') {
      this.checkAutoCompaction(false);
    }
  }

  private checkAutoCompaction(throwOnLimit = true): boolean {
    if (this.compactionFutile) return false;
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
    void this.dispatcher.dispatch(
      new CompactionBlocked({ agentId: this.agent.agentId, turnId }),
    );
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
      const pendingAfterCompaction = this.tokenCountWithPending();
      this.lastCompactedTokenCount = pendingAfterCompaction;
      const effectiveMax = this.profile.getEffectiveMaxContextTokens();
      this.compactionFutile = effectiveMax > 0 && pendingAfterCompaction >= effectiveMax;
      if (this.compactionFutile) {
        this.log.warn(
          'Compaction could not bring the context under the auto-compaction threshold; ' +
            'the kept messages alone exceed the window, so further auto compaction would ' +
            'only summarize the summary. Pausing auto compaction until the history is ' +
            'replaced or the model changes.',
        );
      }
      if (!this.markCompleted(active)) {
        throw compactionCancelledReason(active);
      }
      const { contextSummary: _contextSummary, ...eventResult } = result;
      void _contextSummary;
      void this.dispatcher.dispatch(
        new CompactionCompleted({ agentId: this.agent.agentId, result: eventResult }),
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
      }
      if (blockedByTurn) {
        throw error;
      }
      void this.dispatcher.dispatch(
        new AgentErrorEvent({ ...toKimiErrorPayload(error), agentId: this.agent.agentId }),
      );
      throw error;
    } finally {
      try {
        this._onDidFinishCompaction.fire(active);
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
    const historyToSummarize = this.flags.enabled(SPINE_FLAG_ID)
      ? this.epochScopedHistory(originalHistory)
      : originalHistory;
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
      let historyForModel: readonly ContextMessage[] = stripDynamicToolContext(historyToSummarize);
      let droppedCount = 0;
      let overflowShrinkCount = 0;
      let emptyOrTruncatedShrinkCount = 0;
      while (true) {
        const messagesToCompact = historyForModel;
        const messages: Message[] = [...messagesToCompact, createUserMessage(instruction)];
        const estimatedCompactionRequestTokens = this.requestTokens(messages);

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
          this.cancelActive(active, 'history_changed');
        }
        throw compactionCancelledReason(active);
      }

      const summary = await this.postProcessSummary(attempt.summary);
      const normalizedDroppedCount = droppedCount === 0 ? undefined : droppedCount;
      const result = this.flags.enabled(SPINE_FLAG_ID)
        ? await this.applyRootCompaction(summary, originalHistory.length, tokensBefore, normalizedDroppedCount)
        : this.context.applyCompaction({
            summary,
            contextSummary: buildCompactionSummaryText(summary),
            compactedCount: originalHistory.length,
            tokensBefore,
            summaryOutputTokens: attempt.usage?.output,
            requestOverheadTokens: this.requestTokens([]),
            droppedCount: normalizedDroppedCount,
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
      if (isAbortError(error)) {
        if (active.cancelReason === 'history_changed') {
          const properties: CompactionFailedEvent = {
            source: data.source,
            tokens_before: tokensBefore,
            duration_ms: Date.now() - startedAt,
            round: 1,
            retry_count: retryCount,
            thinking_effort: thinkingEffort,
            error_type: error instanceof Error ? error.name : 'Unknown',
            trace_id: active.traceId,
          };
          this.telemetry.track2('compaction_failed', properties);
        }
        throw error;
      }
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

  private async applyRootCompaction(
    summary: string,
    compactedCount: number,
    tokensBefore: number,
    droppedCount: number | undefined,
  ): Promise<CompactionResult> {
    const contextSummary = buildCompactionSummaryText(summary);
    const summaryMessage = createCompactionSummaryMessage(contextSummary);
    const summaryAt = this.context.get().length;
    const foldedMessages = this.context.get().slice(0, summaryAt);
    const epoch = this.spine.currentState().rootEpoch + 1;
    const epochStartAt = summaryAt + 1;
    this.context.append(summaryMessage);
    const tokensAfter = estimateTokensForMessages([summaryMessage]);
    const archivePath = await this.spine.archiveEpochRoot({
      epoch,
      epochStartAt,
      epochMemoryAt: summaryAt,
      summary,
      messages: foldedMessages,
    });
    if (archivePath === undefined) {
      this.log.warn(
        'Spine epoch archive could not be written; root compaction proceeds without an archive path.',
        { epoch },
      );
    }
    this.tokenCounting.rebase(agentContextOfScope(this.agent), {
      length: epochStartAt,
      tokens: tokensAfter,
      measured: false,
    });
    return {
      summary,
      contextSummary,
      compactedCount,
      tokensBefore,
      tokensAfter,
      keptUserMessageCount: 0,
      droppedCount,
    };
  }

  private async postProcessSummary(summary: string): Promise<string> {
    const todos = this.currentTodos();
    if (todos.length === 0) {
      return summary;
    }
    return `${summary.trim()}\n\n${renderTodoList(todos, '## TODO List')}`;
  }

  private currentTodos(): readonly TodoItem[] {
    if (this.flags.enabled(SPINE_FLAG_ID)) return [];
    return this.todo.get();
  }

  /**
   * The summary request's input in spine mode: the current epoch's messages,
   * with the previous epoch's summary message chained in front for
   * continuity. Earlier epochs are already folded behind summary + archive,
   * so re-summarizing the append-only full history would spend the whole
   * window (observed at 700k–1M tokens per request) and eventually overflow
   * the shrink ladder.
   */
  private epochScopedHistory(
    history: readonly ContextMessage[],
  ): readonly ContextMessage[] {
    const spineState = this.spine.currentState();
    const start = Math.min(spineState.epochStartAt, history.length);
    const scoped = history.slice(start);
    const summaryAt = spineState.epochMemoryAt;
    const priorSummary =
      summaryAt !== undefined && summaryAt < start ? history[summaryAt] : undefined;
    return priorSummary === undefined ? scoped : [priorSummary, ...scoped];
  }

  private tokenCountWithPending(): number {
    return this.tokenCounting.get(agentContextOfScope(this.agent)).size;
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
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  if (messages.length <= 1) return messages.slice();
  const ratio = COMPACTION_OVERFLOW_SHRINK_RATIOS[
    Math.min(attempt - 1, COMPACTION_OVERFLOW_SHRINK_RATIOS.length - 1)
  ]!;
  let totalTokens = 0;
  for (const message of messages) totalTokens += estimateMessage(message);
  const tokenBudget = Math.floor(totalTokens * ratio);
  return takeRecentMessagesWithinTokenBudget(messages, tokenBudget, estimateMessage);
}

function takeRecentMessagesWithinTokenBudget<T extends Message>(
  messages: readonly T[],
  tokenBudget: number,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  let start = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateMessage(messages[i]!);
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
  ScopeActivation.OnScopeCreated,
  'fullCompaction',
);
