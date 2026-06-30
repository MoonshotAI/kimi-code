import {
  ErrorCodes,
  KimiError,
  isKimiError,
  toKimiErrorPayload,
} from '#/errors';
import {
  APIEmptyResponseError,
  inputTotal,
  isRetryableGenerateError,
  type GenerateResult,
  type Message,
  type TokenUsage,
  APIContextOverflowError,
  APIStatusError,
  createUserMessage,
} from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { isAbortError } from '../../loop/errors';
import {
  retryBackoffDelays,
  sleepForRetry,
} from '../../loop/retry';
import {
  renderTodoList,
  TODO_STORE_KEY,
  type TodoItem,
} from '../../tools/builtin/state/todo-list';
import {
  estimateTokens,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '../../utils/tokens';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '../../utils/completion-budget';
import { renderPrompt } from '../../utils/render-prompt';
import compactionInstructionTemplate from './compaction-instruction.md?raw';
import type { CompactionBeginData, CompactionResult } from './types';
import {
  DEFAULT_COMPACTION_CONFIG,
  DefaultCompactionStrategy,
  type CompactionStrategy,
} from './strategy';
import { buildCompactionSummaryText, isRealUserInput } from './handoff';

export const MAX_COMPACTION_RETRY_ATTEMPTS = 5;

const DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS = 128 * 1024;
const OVERFLOW_CONTEXT_SAFETY_RATIO = 0.85;
const OVERFLOW_STATUS_RECOVERY_RATIO = 0.5;

class CompactionTruncatedError extends Error {
  constructor() {
    super('Compaction response was truncated before producing a complete summary.');
    this.name = 'CompactionTruncatedError';
  }
}

export class FullCompaction {
  protected compactionCountInTurn = 0;
  protected compacting: {
    abortController: AbortController;
    promise: Promise<void>;
    blockedByTurn: boolean;
  } | null = null;
  private readonly observedMaxContextTokensByModel = new Map<string, number>();
  // Token count right after the last successful compaction. While no new
  // content has been appended (tokenCountWithPending <= this value), the
  // history is already in its minimal compacted form ([kept user prompts,
  // summary]); re-compacting would only nest summaries, so
  // checkAutoCompaction skips in that case even if an observed overflow
  // limit still flags the context as oversized.
  private lastCompactedTokenCount: number | null = null;
  // Counts provider-overflow recoveries in this turn that have not yet been
  // followed by a successful step. Trips MAX_OVERFLOW_COMPACTION_ATTEMPTS to
  // stop an overflow -> compact -> overflow loop when compaction can no
  // longer shrink the request below the model window.
  private consecutiveOverflowCompactions = 0;
  protected readonly strategy: CompactionStrategy;

  constructor(
    protected readonly agent: Agent,
    strategy?: CompactionStrategy,
  ) {
    this.strategy =
      strategy ??
      new DefaultCompactionStrategy(
        () => this.getEffectiveMaxContextTokens(),
        {
          ...DEFAULT_COMPACTION_CONFIG,
          reservedContextSize:
            agent.kimiConfig?.loopControl?.reservedContextSize ??
            DEFAULT_COMPACTION_CONFIG.reservedContextSize,
        },
      );
  }

  get isCompacting(): boolean {
    return this.compacting !== null;
  }

  getEffectiveMaxContextTokens(): number {
    const configured = this.agent.config.modelCapabilities.max_context_tokens;
    const modelAlias = this.agent.config.modelAlias;
    const observed =
      modelAlias === undefined ? undefined : this.observedMaxContextTokensByModel.get(modelAlias);
    if (observed === undefined) return configured;
    if (configured <= 0) return observed;
    return Math.min(configured, observed);
  }

  estimateCurrentRequestTokens(): number {
    return this.estimateRequestTokens(this.agent.context.messages);
  }

  shouldRecoverFromContextOverflow(
    error: unknown,
    estimatedRequestTokens = this.estimateCurrentRequestTokens(),
  ): boolean {
    if (error instanceof APIContextOverflowError) return true;
    if (!(error instanceof APIStatusError) || error.statusCode !== 413) return false;
    const effectiveMax = this.getEffectiveMaxContextTokens();
    return (
      effectiveMax > 0 && estimatedRequestTokens >= effectiveMax * OVERFLOW_STATUS_RECOVERY_RATIO
    );
  }

  observeContextOverflow(estimatedRequestTokens: number): void {
    if (!Number.isFinite(estimatedRequestTokens) || estimatedRequestTokens <= 0) return;
    const modelAlias = this.agent.config.modelAlias;
    if (modelAlias === undefined) return;
    const observed = Math.max(
      1,
      Math.floor(estimatedRequestTokens * OVERFLOW_CONTEXT_SAFETY_RATIO),
    );
    const current = this.getEffectiveMaxContextTokens();
    if (current > 0 && observed >= current) return;
    this.observedMaxContextTokensByModel.set(modelAlias, observed);
  }

  begin(data: Readonly<CompactionBeginData>): void {
    if (this.compacting) return;
    if (data.source === 'manual') {
      this.compactionCountInTurn = 0;
    } else {
      this.compactionCountInTurn += 1;
    }
    if (this.compactionCountInTurn > this.strategy.maxCompactionPerTurn) return;
    if (this.agent.records.restoring) {
      this.agent.replayBuilder.push({
        type: 'compaction',
        instruction: data.instruction,
      });
      return;
    }
    if (this.agent.context.history.length === 0) {
      throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'No messages to compact in current history.');
    }
    // Manual (SDK/REST) compaction must not start while a turn is running: the
    // turn keeps mutating the context (streaming content, appending messages)
    // while the summarizer is in flight, and that output is then neither
    // summarized nor preserved by the rebuild. Auto compaction is exempt — it is
    // triggered from within the turn at a step boundary, which blocks the turn
    // for the duration. Refuse manual compaction here so it only runs at a clean
    // boundary; the caller can retry once the turn finishes.
    if (data.source === 'manual' && this.agent.turn.hasActiveTurn) {
      throw new KimiError(
        ErrorCodes.COMPACTION_UNABLE,
        'Cannot compact while a turn is active. Wait for it to finish, then retry.',
      );
    }
    this.agent.records.logRecord({
      type: 'full_compaction.begin',
      ...data,
    });
    this.agent.emitEvent({
      type: 'compaction.started',
      trigger: data.source,
      instruction: data.instruction,
    });
    const abortController = new AbortController();
    this.compacting = {
      abortController,
      promise: this.compactionWorker(abortController.signal, data),
      blockedByTurn: false,
    };
  }

  cancel(): void {
    this.agent.replayBuilder.patchLast('compaction', {
      result: 'cancelled',
    });
    if (!this.compacting) return;
    this.agent.records.logRecord({
      type: 'full_compaction.cancel',
    });
    this.compacting.abortController.abort();
    this.compacting = null;
    this.agent.emitEvent({ type: 'compaction.cancelled' });
  }

  markCompleted() {
    this.agent.records.logRecord({
      type: 'full_compaction.complete',
    });
    this.compacting = null;
  }

  private get tokenCountWithPending(): number {
    return this.agent.context.tokenCountWithPending;
  }

  private estimateRequestTokens(messages: readonly Message[]): number {
    return (
      estimateTokens(this.agent.config.systemPrompt) +
      estimateTokensForTools(this.agent.tools.loopTools) +
      estimateTokensForMessages(messages)
    );
  }

  resetForTurn(): void {
    this.compactionCountInTurn = 0;
    this.lastCompactedTokenCount = null;
    this.consecutiveOverflowCompactions = 0;
  }

  async handleOverflowError(signal: AbortSignal, error: unknown) {
    this.consecutiveOverflowCompactions += 1;
    const maxAttempts = this.strategy.maxOverflowCompactionAttempts;
    if (this.consecutiveOverflowCompactions > maxAttempts) {
      throw new KimiError(
        ErrorCodes.CONTEXT_OVERFLOW,
        `Compaction failed to bring the context under the model window after ${String(maxAttempts)} attempts.`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
    const didStartCompaction = this.beginAutoCompaction();
    if (!didStartCompaction && !this.compacting) throw error;
    // Always block on overflow errors
    await this.block(signal);
  }

  async beforeStep(signal: AbortSignal): Promise<void> {
    this.checkAutoCompaction();
    if (this.strategy.shouldBlock(this.tokenCountWithPending)) {
      await this.block(signal);
    }
  }

  async afterStep(): Promise<void> {
    // A completed step means a generate() succeeded, so any prior
    // overflow -> compact cycle produced a request that now fits; clear the
    // loop guard.
    this.consecutiveOverflowCompactions = 0;
    if (this.strategy.checkAfterStep) {
      this.checkAutoCompaction(false);
    }
    // Do not block after the step
  }

  private checkAutoCompaction(throwOnLimit: boolean = true): boolean {
    if (this.compacting) return true;
    if (
      this.lastCompactedTokenCount !== null &&
      this.tokenCountWithPending <= this.lastCompactedTokenCount
    ) {
      return false;
    }
    if (!this.strategy.shouldCompact(this.tokenCountWithPending)) return false;
    return this.beginAutoCompaction(throwOnLimit);
  }

  private beginAutoCompaction(throwOnLimit: boolean = true): boolean {
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
    this.begin({ source: 'auto', instruction: undefined });
    return this.compacting !== null;
  }

  private async block(signal: AbortSignal): Promise<void> {
    const active = this.compacting;
    if (active) {
      active.blockedByTurn = true;
      signal.addEventListener('abort', () => {
        if (this.compacting === active) {
          this.cancel();
        }
      });
      this.agent.emitEvent({
        type: 'compaction.blocked',
        turnId: this.agent.turn.currentId,
      });
      await active.promise;
    }
  }

  private async compactionWorker(
    signal: AbortSignal,
    data: Readonly<CompactionBeginData>,
  ): Promise<void> {
    try {
      const result = await this.compactionRound(signal, data);
      if (!result) return;
      // Stay "compacting" through reinjection: a follow-up prompt/steer that lands
      // now is buffered (TurnFlow defers on `isCompacting`) until the
      // post-compaction reminders are back, so the first post-compaction turn
      // never builds a request before they are reinjected. Only after reinjection
      // do we clear the flag, announce completion, and replay deferred input.
      try {
        await this.agent.refreshSystemPrompt();
      } catch (error) {
        this.agent.log.error('failed to refresh system prompt after compaction', { error });
      }
      await this.agent.injection.injectAfterCompaction();
      this.markCompleted();
      const { contextSummary: _contextSummary, ...eventResult } = result;
      void _contextSummary;
      this.agent.emitEvent({ type: 'compaction.completed', result: eventResult });
      this.triggerPostCompactHook(data, result);
    } catch (error) {
      if (isAbortError(error)) return;
      const blockedByTurn = this.compacting?.blockedByTurn === true;
      this.cancel();
      this.agent.log.error('compaction failed', { error });
      if (blockedByTurn) {
        throw error;
      }
      this.agent.emitEvent({
        type: 'error',
        ...toKimiErrorPayload(error),
      });
    } finally {
      // Replay prompts/steers deferred while compaction held the context — on the
      // success path (after reinjection above), on an A1 prefix/tail cancel
      // (`!result`), and on failure/abort. `compacting` is null by now in every
      // path, so the replay's launch actually starts a turn instead of re-buffering.
      this.agent.turn.onCompactionFinished();
    }
  }

  private buildInstruction(customInstruction: string | undefined): string {
    return renderPrompt(compactionInstructionTemplate, {
      customInstruction: customInstruction?.trim() ?? '',
    }).trimEnd();
  }

  private postProcessSummary(summary: string): string {
    const storeData = this.agent.tools.storeData();
    const todos = (storeData[TODO_STORE_KEY] as readonly TodoItem[] | undefined) ?? [];
    if (todos.length === 0) {
      return summary;
    }
    const todoMarkdown = renderTodoList(todos, '## TODO List');
    return `${summary.trim()}\n\n${todoMarkdown}`;
  }

  private async compactionRound(
    signal: AbortSignal,
    data: Readonly<CompactionBeginData>,
  ): Promise<CompactionResult | undefined> {
    const startedAt = Date.now();
    const originalHistory = [...this.agent.context.history];
    const tokensBefore = estimateTokensForMessages(originalHistory);
    let retryCount = 0;
    try {
      await this.triggerPreCompactHook(data, tokensBefore, signal);

      const model = this.agent.config.model;
      const capability = this.agent.config.modelCapabilities;
      const maxContextTokens = capability.max_context_tokens;
      // When the model's context window is known and the user has not set
      // `maxOutputSize`, cap compaction output to a safe default so a large
      // context window does not push `max_tokens` past the provider's ceiling.
      // When the window is unknown (maxContextTokens === 0), leave
      // `maxOutputSize` unset so `resolveCompletionBudget` falls back to the
      // conservative unknown-context fallback.
      const defaultCompactionCap =
        maxContextTokens > 0
          ? Math.min(maxContextTokens, DEFAULT_COMPACTION_MAX_COMPLETION_TOKENS)
          : undefined;
      const provider = applyCompletionBudget({
        provider: this.agent.config.provider,
        budget: resolveCompletionBudget({
          maxOutputSize: this.agent.config.maxOutputSize ?? defaultCompactionCap,
          reservedContextSize: this.agent.kimiConfig?.loopControl?.reservedContextSize,
        }),
        capability,
      });
      const instruction = this.buildInstruction(data.instruction);

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      let usage: TokenUsage | null = null;
      let summary: string | undefined;
      // Compact the whole history, trimming old messages only when the
      // summarizer request itself cannot fit. Any trimmed messages are not
      // covered by the produced summary; `droppedCount` reports that blind spot.
      let historyForModel = originalHistory;
      let droppedCount = 0;
      let overflowShrinkCount = 0;
      let emptyOrTruncatedShrinkCount = 0;
      while (true) {
        const messages = [
          ...this.agent.context.project(historyForModel, { synthesizeMissing: true }),
          createUserMessage(instruction),
        ];
        const estimatedCompactionRequestTokens = this.estimateRequestTokens(messages);
        try {
          const response = await this.agent.generate(
            provider,
            this.agent.config.systemPrompt,
            [...this.agent.tools.loopTools],
            messages,
            undefined,
            { signal },
          );
          if (response.finishReason === 'truncated') {
            throw new CompactionTruncatedError();
          }
          usage = response.usage;
          summary = extractCompactionSummary(response);
          break;
        } catch (error) {
          const isContextOverflow = this.shouldRecoverFromContextOverflow(
            error,
            estimatedCompactionRequestTokens,
          );
          if (isContextOverflow) {
            this.observeContextOverflow(estimatedCompactionRequestTokens);
          }
          if (isContextOverflow && historyForModel.length > 1) {
            overflowShrinkCount += 1;
            if (overflowShrinkCount > MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS) {
              throw error;
            }
            const before = historyForModel.length;
            historyForModel = shrinkCompactionHistoryAfterOverflow(
              historyForModel,
              overflowShrinkCount,
            );
            droppedCount += before - historyForModel.length;
            retryCount = 0;
            continue;
          }
          const shouldShrinkAfterEmptyOrTruncated =
            error instanceof CompactionTruncatedError ||
            error instanceof APIEmptyResponseError;
          if (shouldShrinkAfterEmptyOrTruncated && historyForModel.length > 1) {
            // Each empty/truncated summary drops the oldest message and retries,
            // but without its own bound this would issue ~one request per message
            // (resetting retryCount sidesteps the transient-error budget). Cap the
            // shrink attempts by the same retry budget so a model that keeps
            // returning empty cannot fan out into a request per history entry.
            emptyOrTruncatedShrinkCount += 1;
            if (emptyOrTruncatedShrinkCount > MAX_COMPACTION_RETRY_ATTEMPTS) {
              throw error;
            }
            const before = historyForModel.length;
            historyForModel = dropOldestMessageAndLeadingToolResults(historyForModel);
            droppedCount += before - historyForModel.length;
            retryCount = 0;
            continue;
          }
          if (!isRetryableGenerateError(error)) {
            throw error;
          }
          if (retryCount + 1 >= MAX_COMPACTION_RETRY_ATTEMPTS) {
            throw error;
          }
          await sleepForRetry(delays[retryCount]!, signal);
          retryCount += 1;
        }
      }

      if (usage !== null) {
        this.agent.usage.record(model, usage);
      }

      const newHistory = this.agent.context.history;
      for (let i = 0; i < originalHistory.length; i++) {
        if (newHistory[i] !== originalHistory[i]) {
          // The compacted prefix changed under us (e.g. undo). Bail.
          this.cancel();
          return undefined;
        }
      }
      // The prefix is intact, but the tail grew while the summarizer was in
      // flight (a live step racing a manual/SDK compaction). A real user message
      // is safe — the all-user rebuild picks recent user input back up from the
      // grown history — but anything compaction would drop (an assistant/tool
      // turn, or a user-role message like a background-task notification, hook/
      // cron reminder, or shell output) was neither summarized (the summary only
      // covers originalHistory) nor kept, so it would silently vanish. Cancel and
      // let a later clean-boundary compaction handle it.
      if (newHistory.slice(originalHistory.length).some((message) => !isRealUserInput(message))) {
        this.cancel();
        return undefined;
      }

      const rawSummary = this.postProcessSummary(summary ?? '');
      const contextSummary = buildCompactionSummaryText(rawSummary);
      const result = this.agent.context.applyCompaction({
        summary: rawSummary,
        contextSummary,
        compactedCount: originalHistory.length,
        tokensBefore,
        droppedCount: droppedCount === 0 ? undefined : droppedCount,
      });

      // Telemetry keys are snake_case, but the `context.apply_compaction`
      // record written below keeps its persisted camelCase field names
      // (consumed by external projectors). The two channels intentionally
      // diverge — don't rename the record side to match.
      this.agent.telemetry.track('compaction_finished', {
        source: data.source,
        tokens_before: result.tokensBefore,
        tokens_after: result.tokensAfter,
        duration_ms: Date.now() - startedAt,
        compacted_count: result.compactedCount,
        dropped_count: result.droppedCount,
        retry_count: retryCount,
        round: 1,
        thinking_effort: this.agent.config.thinkingEffort,
        ...(usage === null
          ? {}
          : { input_tokens: inputTotal(usage), output_tokens: usage.output }),
      });
      this.lastCompactedTokenCount = result.tokensAfter;
      return result;
    } catch (error) {
      if (isAbortError(error)) return undefined;
      this.agent.telemetry.track('compaction_failed', {
        source: data.source,
        tokens_before: tokensBefore,
        duration_ms: Date.now() - startedAt,
        round: 1,
        retry_count: retryCount,
        thinking_effort: this.agent.config.thinkingEffort,
        error_type: error instanceof Error ? error.name : 'Unknown',
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
    await this.agent.hooks?.trigger('PreCompact', {
      matcherValue: data.source,
      signal,
      inputData: {
        trigger: data.source,
        tokenCount,
      },
    });
    signal.throwIfAborted();
  }

  private triggerPostCompactHook(
    data: Readonly<CompactionBeginData>,
    result: CompactionResult,
  ): void {
    void this.agent.hooks?.fireAndForgetTrigger('PostCompact', {
      matcherValue: data.source,
      inputData: {
        trigger: data.source,
        estimatedTokenCount: result.tokensAfter,
      },
    });
  }
}

const MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS = 3;
const COMPACTION_OVERFLOW_SHRINK_RATIOS = [0.7, 0.5, 0.35] as const;

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

function extractCompactionSummary(response: GenerateResult): string {
  const summary =
    typeof response.message.content === 'string'
      ? response.message.content
      : response.message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

  if (summary.trim().length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }
  return summary;
}
