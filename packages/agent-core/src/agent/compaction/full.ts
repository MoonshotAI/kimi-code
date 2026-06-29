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
import { renderPrompt } from '../../utils/render-prompt';
import {
  estimateTokens,
  estimateTokensForMessages,
  estimateTokensForTools,
} from '../../utils/tokens';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '../../utils/completion-budget';
import compactionInstructionTemplate from './compaction-instruction.md?raw';
import { renderTodoList, type TodoItem } from '../../tools/builtin/state/todo-list';
import type { CompactionBeginData, CompactionResult } from './types';
import {
  DEFAULT_COMPACTION_CONFIG,
  DefaultCompactionStrategy,
  type CompactionStrategy,
} from './strategy';

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
        }
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
    const compactedCount = this.strategy.computeCompactCount(this.agent.context.history, data.source);
    if (compactedCount === 0) {
      throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'No prefix that can be compacted in current history.');
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
      promise: this.compactionWorker(abortController.signal, data, compactedCount),
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
  }

  async handleOverflowError(signal: AbortSignal, error: unknown) {
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
    if (this.strategy.checkAfterStep) {
      this.checkAutoCompaction(false);
    }
    // Do not block after the step
  }

  private checkAutoCompaction(throwOnLimit: boolean = true): boolean {
    if (this.compacting) return true;
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
    compactedCount: number,
  ): Promise<void> {
    try {
      const finalResult = {
        summary: '',
        compactedCount: 1,
        tokensBefore: 0,
        tokensAfter: 0,
      };

      for (let round = 1; ; round++) {
        const result = await this.compactionRound(round, signal, data, compactedCount);
        if (!result) return;

        finalResult.summary = result.summary;
        finalResult.compactedCount += result.compactedCount - 1;
        finalResult.tokensBefore += result.tokensBefore - finalResult.tokensAfter;
        finalResult.tokensAfter = result.tokensAfter;

        if (result.tokensBefore - result.tokensAfter < 1024) break;
        if (!this.strategy.shouldBlock(result.tokensAfter)) break;
        compactedCount = this.strategy.computeCompactCount(this.agent.context.history, data.source);
        if (compactedCount === 0) break;
      }
      this.markCompleted();
      this.agent.emitEvent({ type: 'compaction.completed', result: finalResult });
      await this.agent.injection.injectGoal();
      this.triggerPostCompactHook(data, finalResult);
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
    }
  }

  private async compactionRound(
    round: number,
    signal: AbortSignal,
    data: Readonly<CompactionBeginData>,
    initialCompactedCount: number,
  ) {
    const startedAt = Date.now();
    const originalHistory = [...this.agent.context.history];
    const tokensBefore = estimateTokensForMessages(originalHistory);
    let retryCount = 0;
    try {
      let compactedCount = initialCompactedCount;

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

      const delays = retryBackoffDelays(MAX_COMPACTION_RETRY_ATTEMPTS);
      let usage: TokenUsage | null;
      let summary: string;
      while (true) {
        const messagesToCompact = originalHistory.slice(0, compactedCount);
        const messages = [
          ...this.agent.context.project(messagesToCompact),
          createUserMessage(renderPrompt(compactionInstructionTemplate, { customInstruction: data.instruction ?? '' })),
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
          if (
            isContextOverflow ||
            error instanceof CompactionTruncatedError ||
            error instanceof APIEmptyResponseError // e.g. think-only
          ) {
            compactedCount = this.strategy.reduceCompactOnOverflow(messagesToCompact);
          }
          else if (!isRetryableGenerateError(error)) {
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
          // History changed during compaction, likely due to undo
          this.cancel();
          return undefined;
        }
      }

      summary = this.postProcessSummary(summary);

      const recent = originalHistory.slice(compactedCount);
      const tokensAfter = estimateTokens(summary) + estimateTokensForMessages(recent);

      const result: CompactionResult = {
        summary,
        compactedCount,
        tokensBefore,
        tokensAfter,
      };

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
        retry_count: retryCount,
        round,
        thinking_level: this.agent.config.thinkingLevel,
        ...(usage === null
          ? {}
          : { input_tokens: inputTotal(usage), output_tokens: usage.output }),
      });
      this.agent.context.applyCompaction(result);
      return result;
    } catch (error) {
      if (isAbortError(error)) return;
      this.agent.telemetry.track('compaction_failed', {
        source: data.source,
        tokens_before: tokensBefore,
        duration_ms: Date.now() - startedAt,
        round,
        retry_count: retryCount,
        thinking_level: this.agent.config.thinkingLevel,
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

  private postProcessSummary(summary: string): string {
    const storeData = this.agent.tools.storeData();
    const todos = (storeData['todo'] as readonly TodoItem[] | undefined) ?? [];
    if (todos.length === 0) {
      return summary;
    }
    const todoMarkdown = renderTodoList(todos, '## TODO List');
    return `${summary.trim()}\n\n${todoMarkdown}`;
  }
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
