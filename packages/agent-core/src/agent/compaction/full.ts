import {
  ErrorCodes,
  KimiError,
  isKimiError,
  makeErrorPayload,
  toKimiErrorPayload,
} from '#/errors';
import {
  APIConnectionError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  inputTotal,
  type GenerateResult,
  type Message,
  type TokenUsage,
} from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { isAbortError } from '../../loop/errors';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  retryBackoffDelays,
  sleepForRetry,
} from '../../loop/retry';
import type { TelemetryPropertyValue } from '../../telemetry';
import {
  applyCompletionBudget,
  resolveCompletionBudget,
} from '../../utils/completion-budget';
import { renderPrompt } from '../../utils/render-prompt';
import {
  estimateTokens,
  estimateTokensForMessage,
  estimateTokensForMessages,
} from '../../utils/tokens';
import { sliceCompleteMessages } from '../context/complete-slice';
import { project } from '../context/projector';
import compactionInstructionTemplate from './compaction-instruction.md';
import { DEFAULT_COMPACTION_CONFIG, type CompactionConfig } from './config';
import { renderMessagesToText } from './render-messages';
import type { CompactionBeginData, CompactionResult } from './types';

export interface CompactionStrategy {
  shouldCompact(usedSize: number, maxSize: number): boolean;
  shouldBlock(usedSize: number, maxSize: number): boolean;
  computeCompactCount(messages: readonly Message[], maxSize: number): number;
  readonly checkAfterStep: boolean;
  readonly maxCompactionPerTurn: number;
}

export class DefaultCompactionStrategy implements CompactionStrategy {
  constructor(protected readonly config: CompactionConfig = DEFAULT_COMPACTION_CONFIG) {}

  shouldCompact(usedSize: number, maxSize: number): boolean {
    if (maxSize <= 0) return false;
    return (
      usedSize >= maxSize * this.config.triggerRatio ||
      this.shouldUseReservedContext(maxSize, usedSize)
    );
  }

  shouldBlock(usedSize: number, maxSize: number): boolean {
    if (maxSize <= 0) return false;
    return (
      usedSize >= maxSize * this.config.blockRatio ||
      this.shouldUseReservedContext(maxSize, usedSize)
    );
  }

  private shouldUseReservedContext(maxSize: number, usedSize: number): boolean {
    const reservedSize = this.config.reservedContextSize;
    return reservedSize > 0 && reservedSize < maxSize && usedSize + reservedSize >= maxSize;
  }

  computeCompactCount(messages: readonly Message[], maxSize: number) {
    let splitAt = messages.length;
    let recentSize = 0;
    let userMessageCount = 0;
    let onlySeenTrailingUsers = true;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m1 = messages[i - 1];
      const m2 = messages[i];
      if (m2 === undefined) continue;
      const isTrailingAssistantPlaceholder =
        onlySeenTrailingUsers &&
        m2.role === 'assistant' &&
        m2.content.length === 0 &&
        m2.toolCalls.length === 0;
      if (isTrailingAssistantPlaceholder) {
        splitAt = i;
        continue;
      }
      const isTrailingUserMessage = onlySeenTrailingUsers && m2.role === 'user';
      if (!isTrailingUserMessage && messages.length - i >= this.config.maxRecentSteps) break;

      if (m2.role === 'user') {
        userMessageCount++;
        if (!isTrailingUserMessage && userMessageCount > this.config.maxRecentUserMessages) {
          break;
        }
      }

      recentSize += estimateTokensForMessage(m2);
      if (isTrailingUserMessage) {
        splitAt = i;
        continue;
      }
      if (recentSize > maxSize * this.config.maxRecentSizeRatio) {
        break;
      }
      const canSplitBeforeMessage =
        m1?.role !== m2.role && !(m1?.role === 'user' && m2.role === 'assistant') && m2.role !== 'tool';
      if (canSplitBeforeMessage) {
        splitAt = i;
      }
      if (m2.role !== 'user') {
        onlySeenTrailingUsers = false;
      }
    }

    return splitAt;
  }

  get checkAfterStep(): boolean {
    return this.config.triggerRatio !== this.config.blockRatio;
  }

  get maxCompactionPerTurn(): number {
    return this.config.maxCompactionPerTurn;
  }
}

export interface CompactedHistory {
  text: string;
}

type CompactionTelemetryTrigger = CompactionBeginData['source'] | 'manual-with-prompt' | 'unknown';

export class FullCompaction {
  protected compactionCountInTurn = 0;
  protected compacting: {
    abortController: AbortController;
    startedAt: number;
    telemetryTrigger: CompactionTelemetryTrigger;
    promise: Promise<void>;
  } | null = null;
  protected _compactedHistory: CompactedHistory[] = [];
  protected readonly strategy: CompactionStrategy;

  constructor(
    protected readonly agent: Agent,
    strategy?: CompactionStrategy,
  ) {
    this.strategy =
      strategy ??
      new DefaultCompactionStrategy({
        ...DEFAULT_COMPACTION_CONFIG,
        reservedContextSize:
          agent.providerManager?.config.loopControl?.reservedContextSize ??
          DEFAULT_COMPACTION_CONFIG.reservedContextSize,
      });
  }

  get isCompacting(): boolean {
    return this.compacting !== null;
  }

  begin(data: Readonly<CompactionBeginData>): void {
    this.agent.records.logRecord({
      type: 'full_compaction.begin',
      ...data,
    });
    if (this.compacting) return;
    if (data.source === 'manual') {
      this.compactionCountInTurn = 0;
    } else {
      this.compactionCountInTurn += 1;
    }
    if (this.compactionCountInTurn > this.strategy.maxCompactionPerTurn) return;
    if (!this.agent.records.restoring) {
      this.startCompactionWorker(data);
    }
  }

  private startCompactionWorker(data: Readonly<CompactionBeginData>): void {
    const abortController = new AbortController();
    this.agent.emitEvent({
      type: 'compaction.started',
      trigger: data.source,
      instruction: data.instruction,
    });
    const active = {
      abortController,
      startedAt: Date.now(),
      telemetryTrigger: compactionTelemetryTrigger(data.source, data.instruction),
      promise: Promise.resolve(),
    };
    this.compacting = active;
    active.promise = this.compactionWorker(abortController.signal, data);
  }

  cancel(): void {
    this.markCanceled();
  }

  private markCanceled(): void {
    if (!this.compacting) return;
    this.agent.records.logRecord({
      type: 'full_compaction.cancel',
    });
    this.compacting.abortController.abort();
    this.compacting = null;
    this.agent.emitEvent({ type: 'compaction.cancelled' });
  }

  complete(
    result: CompactionResult,
    llmUsage?: TokenUsage | undefined,
    retryCount: number = 0,
  ): void {
    this.agent.records.logRecord({
      type: 'full_compaction.complete',
      ...result,
    });
    const active = this.compacting;
    this.compacting = null;
    const history = this.agent.context.history;
    this._compactedHistory.push({
      text: renderMessagesToText(history),
    });
    this.agent.emitEvent({ type: 'compaction.completed', result });
    if (active !== null) {
      const properties: Record<string, TelemetryPropertyValue> = {
        trigger_type: active.telemetryTrigger,
        before_tokens: result.tokensBefore,
        after_tokens: result.tokensAfter,
        duration_ms: Date.now() - active.startedAt,
        compacted_count: result.compactedCount,
        retry_count: retryCount,
      };
      if (llmUsage !== undefined) {
        properties['llm_input_tokens'] = inputTotal(llmUsage);
        properties['llm_output_tokens'] = llmUsage.output;
      }
      this.agent.telemetry.track('compaction_finished', properties);
    }
  }

  private get tokenCountWithPending(): number {
    return this.agent.context.tokenCountWithPending;
  }

  private get maxContextSize() {
    return this.agent.config.modelCapabilities.max_context_tokens;
  }

  private get shouldCompact(): boolean {
    return this.strategy.shouldCompact(this.tokenCountWithPending, this.maxContextSize);
  }

  private get shouldBlock(): boolean {
    return this.strategy.shouldBlock(this.tokenCountWithPending, this.maxContextSize);
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
    if (this.shouldBlock) {
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
    if (!this.shouldCompact) return false;

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
    const history = this.agent.context.history;
    const compactedCount = this.computeCompactableCount(history);
    if (compactedCount === 0) return false;
    if (
      this.maxContextSize > 0 &&
      estimateTokensForMessages(project(history.slice(compactedCount))) >= this.maxContextSize
    ) {
      return false;
    }
    this.agent.fullCompaction.begin({ source: 'auto', instruction: undefined });
    return true;
  }

  private async block(signal: AbortSignal): Promise<void> {
    const active = this.compacting;
    if (active) {
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
    const startedAt = Date.now();
    let tokensBeforeForError = 0;
    let retryCountForTelemetry = 0;
    try {
      const originalHistory = [...this.agent.context.history];
      const tokensBefore = this.agent.context.tokenCount;
      tokensBeforeForError = tokensBefore;
      const compactedCount = this.computeCompactableCount(originalHistory);
      if (compactedCount === 0) {
        this.markCanceled();
        return undefined;
      }
      signal.throwIfAborted();
      await this.triggerPreCompactHook(data, tokensBefore, signal);
      signal.throwIfAborted();

      const model = this.agent.config.model;
      const messages = [
        ...project(originalHistory.slice(0, compactedCount)),
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: COMPACTION_INSTRUCTION(data.instruction),
            },
          ],
          toolCalls: [],
        } satisfies Message,
      ];
      const { response, retryCount, summary } = await this.generateCompactionResponse({
        messages,
        signal,
        onRetry: (count) => {
          retryCountForTelemetry = count;
        },
      });
      if (response.usage !== null) {
        this.agent.usage.record(model, response.usage);
      }

      const newHistory = this.agent.context.history;
      for (let i = 0; i < originalHistory.length; i++) {
        if (newHistory[i] !== originalHistory[i]) {
          // History changed during compaction, likely due to undo
          this.cancel();
          return undefined;
        }
      }

      const recent = originalHistory.slice(compactedCount);
      const tokensAfter = estimateTokens(summary) + estimateTokensForMessages(project(recent));

      const result: CompactionResult = {
        summary,
        compactedCount,
        tokensBefore,
        tokensAfter,
      };

      this.complete(result, response.usage ?? undefined, retryCount);
      this.agent.context.applyCompaction(result);
      this.triggerPostCompactHook(data, result);
    } catch (error) {
      if (!isAbortError(error)) {
        this.agent.log.error('compaction failed', {
          code: isKimiError(error) ? error.code : undefined,
          error,
        });
        this.markCanceled();
        const payload =
          isKimiError(error) && error.code === ErrorCodes.AUTH_LOGIN_REQUIRED
            ? toKimiErrorPayload(error)
            : makeErrorPayload(ErrorCodes.COMPACTION_FAILED, String(error));
        this.agent.emitEvent({
          type: 'error',
          ...payload,
        });
        this.agent.telemetry.track('compaction_failed', {
          trigger_type: compactionTelemetryTrigger(data.source, data.instruction),
          before_tokens: tokensBeforeForError,
          duration_ms: Date.now() - startedAt,
          retry_count: retryCountForTelemetry,
          error_type: error instanceof Error ? error.name : 'Unknown',
        });
      }
    }
  }

  private async generateCompactionResponse({
    messages,
    signal,
    onRetry,
  }: {
    readonly messages: Message[];
    readonly signal: AbortSignal;
    readonly onRetry?: ((retryCount: number) => void) | undefined;
  }): Promise<{
    readonly response: GenerateResult;
    readonly summary: string;
    readonly retryCount: number;
  }> {
    const maxAttempts =
      this.agent.providerManager?.config.loopControl?.maxRetriesPerStep ??
      DEFAULT_MAX_RETRY_ATTEMPTS;
    const delays = retryBackoffDelays(maxAttempts);
    let retryCount = 0;

    // Use an optimistic cap for compaction. Local tool/schema estimates can
    // overcount and starve summary generation; the provider can clamp against
    // the actual serialized request if the cap is too large.
    const completionBudget = resolveCompletionBudget({
      reservedContextSize:
        this.agent.providerManager?.config.loopControl?.reservedContextSize,
    });
    const effectiveProvider = applyCompletionBudget({
      provider: this.agent.config.provider,
      budget: completionBudget,
      capability: this.agent.config.modelCapabilities,
      inputTokenCount: 0,
    });

    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await this.agent.generate(
          effectiveProvider,
          this.agent.config.systemPrompt,
          [...this.agent.tools.loopTools],
          messages,
          undefined,
          { signal },
        );
        const summary = extractCompactionSummary(response);
        return { response, summary, retryCount };
      } catch (error) {
        if (attempt >= maxAttempts || !isRetryableCompactionError(error)) {
          throw error;
        }
        retryCount += 1;
        onRetry?.(retryCount);
        await sleepForRetry(delays[attempt - 1] ?? 0, signal);
      }
    }
  }

  get compactedHistory(): readonly CompactedHistory[] {
    return this._compactedHistory;
  }

  private async triggerPreCompactHook(
    data: Readonly<CompactionBeginData>,
    tokenCount: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.agent.hooks?.trigger('PreCompact', {
      matcherValue: data.source,
      signal,
      inputData: {
        trigger: data.source,
        tokenCount,
      },
    });
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

  private computeCompactableCount(history: readonly Message[]): number {
    return sliceCompleteMessages(
      history,
      this.strategy.computeCompactCount(history, this.maxContextSize),
    );
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

export const COMPACTION_INSTRUCTION = (customInstruction = ''): string =>
  renderPrompt(compactionInstructionTemplate, { customInstruction });

function compactionTelemetryTrigger(
  trigger: CompactionBeginData['source'] | undefined,
  instruction: string | undefined,
): CompactionTelemetryTrigger {
  if (trigger === undefined) return 'unknown';
  if (trigger === 'manual' && instruction !== undefined && instruction.length > 0) {
    return 'manual-with-prompt';
  }
  return trigger;
}

function isRetryableCompactionError(error: unknown): boolean {
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return true;
  }
  if (error instanceof APIEmptyResponseError) {
    return true;
  }
  if (!(error instanceof APIStatusError)) return false;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && [429, 500, 502, 503, 504].includes(statusCode);
}
