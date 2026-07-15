import type { Message } from '#/app/llmProtocol/message';
import type { ProfileModelContext } from '#/agent/profile/profile';
import type { CompactionSource } from './types';
import { estimateTokensForMessage } from '#/_base/utils/tokens';

export interface CompactionConfig {
  triggerRatio: number;
  blockRatio: number;
  reservedContextSize: number;
  maxCompactionPerTurn: number;
  maxOverflowCompactionAttempts: number;
  maxRecentMessages: number;
  maxRecentUserMessages: number;
  maxRecentSizeRatio: number;
  minOverflowReductionRatio: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerRatio: 0.85,
  blockRatio: 0.85,
  reservedContextSize: 50_000,
  maxCompactionPerTurn: Infinity,
  maxOverflowCompactionAttempts: 3,
  maxRecentMessages: 4,
  maxRecentUserMessages: Infinity,
  maxRecentSizeRatio: 0.2,
  minOverflowReductionRatio: 0.05,
};

export interface CompactionStrategy {
  shouldCompact(usedSize: number): boolean;
  shouldBlock(usedSize: number): boolean;
  computeCompactCount(messages: readonly Message[], source: CompactionSource): number;
  reduceCompactOnOverflow(messages: readonly Message[]): number;
  readonly checkAfterStep: boolean;
  readonly maxCompactionPerTurn: number;
  readonly maxOverflowCompactionAttempts: number;
}

export class RuntimeCompactionStrategy implements CompactionStrategy {
  constructor(private readonly context: () => ProfileModelContext) { }

  shouldCompact(usedSize: number): boolean {
    return this.delegate().shouldCompact(usedSize);
  }

  shouldBlock(usedSize: number): boolean {
    return this.delegate().shouldBlock(usedSize);
  }

  computeCompactCount(messages: readonly Message[], source: CompactionSource): number {
    return this.windowDelegate().computeCompactCount(messages, source);
  }

  reduceCompactOnOverflow(messages: readonly Message[]): number {
    return this.windowDelegate().reduceCompactOnOverflow(messages);
  }

  get checkAfterStep(): boolean {
    return this.config().triggerRatio !== this.config().blockRatio;
  }

  get maxCompactionPerTurn(): number {
    return DEFAULT_COMPACTION_CONFIG.maxCompactionPerTurn;
  }

  get maxOverflowCompactionAttempts(): number {
    return DEFAULT_COMPACTION_CONFIG.maxOverflowCompactionAttempts;
  }

  private delegate(): DefaultCompactionStrategy {
    const model = this.context();
    return new DefaultCompactionStrategy(
      () => model.modelCapabilities.max_context_tokens,
      this.config(model),
    );
  }

  private windowDelegate(): DefaultCompactionStrategy {
    return new DefaultCompactionStrategy(
      () => this.context().modelCapabilities.max_context_tokens,
      DEFAULT_COMPACTION_CONFIG,
    );
  }

  private config(model: ProfileModelContext = this.context()): CompactionConfig {
    const triggerRatio = model.compactionTriggerRatio ?? DEFAULT_COMPACTION_CONFIG.triggerRatio;
    const blockRatio = Math.max(triggerRatio, DEFAULT_COMPACTION_CONFIG.blockRatio);
    return {
      ...DEFAULT_COMPACTION_CONFIG,
      triggerRatio,
      blockRatio,
      reservedContextSize:
        model.reservedContextSize ?? DEFAULT_COMPACTION_CONFIG.reservedContextSize,
    };
  }
}


export class DefaultCompactionStrategy implements CompactionStrategy {
  constructor(
    protected readonly maxSizeProvider: () => number,
    protected readonly config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
  ) { }

  protected get maxSize(): number {
    return this.maxSizeProvider();
  }

  shouldCompact(usedSize: number): boolean {
    if (this.maxSize <= 0) return false;
    return (
      usedSize >= this.maxSize * this.config.triggerRatio ||
      this.shouldUseReservedContext(usedSize)
    );
  }

  shouldBlock(usedSize: number): boolean {
    if (this.maxSize <= 0) return false;
    return (
      usedSize >= this.maxSize * this.config.blockRatio ||
      this.shouldUseReservedContext(usedSize)
    );
  }

  private shouldUseReservedContext(usedSize: number): boolean {
    const reservedSize = this.config.reservedContextSize;
    return reservedSize > 0 && reservedSize < this.maxSize && usedSize + reservedSize >= this.maxSize;
  }

  computeCompactCount(messages: readonly Message[], source: CompactionSource): number {

    if (source === 'manual') {
      for (let i = messages.length - 1; i > 0; i--) {
        if (canSplitAfter(messages, i)) {
          return this.fitCompactCountToWindow(messages, i + 1);
        }
      }
      return 0;
    }


    let recentMessages = 1;
    let recentUserMessages = 0;
    let recentSize = 0;
    let bestN: number | undefined;

    for (; recentMessages < messages.length; recentMessages++) {
      const splitIndex = messages.length - recentMessages - 1;
      const m2 = messages[messages.length - recentMessages]!;

      if (m2.role === 'user') {
        recentUserMessages++;
      }
      recentSize += estimateTokensForMessage(m2);

      if (canSplitAfter(messages, splitIndex)) {
        bestN = splitIndex + 1;
      }

      const reachesMax = recentMessages >= this.config.maxRecentMessages
        || recentUserMessages >= this.config.maxRecentUserMessages
        || recentSize >= this.maxSize * this.config.maxRecentSizeRatio;
      if (reachesMax && bestN !== undefined) {
        break;
      }
    }

    return this.fitCompactCountToWindow(messages, bestN ?? 0);
  }

  reduceCompactOnOverflow(messages: readonly Message[]): number {
    const minReducedSize = Math.max(
      1,
      Math.ceil(this.maxSize * this.config.minOverflowReductionRatio),
    );
    let reducedSize = 0;
    let bestN: number | undefined;

    for (let i = messages.length - 2; i > 0; i--) {
      reducedSize += estimateTokensForMessage(messages[i + 1]!);
      if (canSplitAfter(messages, i)) {
        bestN = i + 1;
        if (reducedSize >= minReducedSize) {
          return i + 1;
        }
      }
    }
    return bestN ?? messages.length;
  }

  private fitCompactCountToWindow(
    messages: readonly Message[],
    compactedCount: number,
  ): number {
    if (this.maxSize <= 0 || compactedCount <= 0) {
      return compactedCount;
    }

    let compactedSize = 0;
    for (let i = 0; i < compactedCount; i++) {
      compactedSize += estimateTokensForMessage(messages[i]!);
    }
    if (compactedSize <= this.maxSize) {
      return compactedCount;
    }

    let bestN: number | undefined;
    for (let n = compactedCount - 1; n > 0; n--) {
      compactedSize -= estimateTokensForMessage(messages[n]!);
      if (!canSplitAfter(messages, n - 1)) {
        continue;
      }
      bestN = n;
      if (compactedSize <= this.maxSize) {
        return n;
      }
    }

    return bestN ?? compactedCount;
  }

  get checkAfterStep(): boolean {
    return this.config.triggerRatio !== this.config.blockRatio;
  }

  get maxCompactionPerTurn(): number {
    return this.config.maxCompactionPerTurn;
  }

  get maxOverflowCompactionAttempts(): number {
    return this.config.maxOverflowCompactionAttempts;
  }
}

function canSplitAfter(messages: readonly Message[], index: number): boolean {
  const m = messages[index];
  if (m === undefined) return false;
  if (m.role === 'user') return false;
  if (m.role === 'assistant' && m.toolCalls.length > 0) return false;
  if (messages[index + 1]?.role === 'tool') return false;
  if (prefixEndsWithOpenToolExchange(messages, index)) return false;
  return true;
}

function prefixEndsWithOpenToolExchange(messages: readonly Message[], index: number): boolean {
  if (messages[index]?.role !== 'tool') return false;

  let toolResultCount = 0;
  for (let i = index; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) return false;
    if (message.role === 'tool') {
      toolResultCount++;
      continue;
    }
    return message.role === 'assistant' && message.toolCalls.length > toolResultCount;
  }
  return false;
}
