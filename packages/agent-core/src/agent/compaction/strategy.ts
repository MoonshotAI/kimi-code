import type { CompactionSource } from './types';

interface CompactionMessageMeta {
  role: string;
  toolCallsCount: number;
  tokens: number;
}

interface CompactionConfigMeta {
  maxSize: number;
  maxRecentMessages: number;
  maxRecentUserMessages: number;
  maxRecentSizeRatio: number;
  minOverflowReductionRatio: number;
}

// ── Native module loading (lazy, with TS fallback) ──────────────────────────

let nativeCompaction: {
  nativeComputeCompactCount?: (messages: CompactionMessageMeta[], config: CompactionConfigMeta, isManual: boolean) => number;
  nativeReduceCompactOnOverflow?: (messages: CompactionMessageMeta[], config: CompactionConfigMeta) => number;
} | null | undefined;

function getNativeCompaction() {
  if (nativeCompaction === null) return undefined;
  if (nativeCompaction !== undefined) return nativeCompaction;
  try {
    nativeCompaction = require('@moonshot-ai/kimi-native-tools');
    return nativeCompaction;
  } catch {
    nativeCompaction = null;
    return undefined;
  }
}

function toCompactionMeta(messages: readonly Message[]): CompactionMessageMeta[] {
  return messages.map((m) => ({
    role: m.role,
    toolCallsCount: m.toolCalls.length,
    tokens: estimateTokensForMessage(m),
  }));
}

function toCompactionConfig(maxSize: number, config: CompactionConfig): CompactionConfigMeta {
  return {
    maxSize,
    maxRecentMessages: Number.isFinite(config.maxRecentMessages) ? config.maxRecentMessages : 0xFFFFFFFF,
    maxRecentUserMessages: Number.isFinite(config.maxRecentUserMessages) ? config.maxRecentUserMessages : 0xFFFFFFFF,
    maxRecentSizeRatio: config.maxRecentSizeRatio,
    minOverflowReductionRatio: config.minOverflowReductionRatio,
  };
}

export interface CompactionConfig {
  /** Fraction of the model context window that triggers auto-compaction. */
  triggerRatio: number;
  /** Fraction of the model context window that blocks the turn on compaction. */
  blockRatio: number;
  /** Reserved output budget; compaction triggers early to leave this much room. */
  reservedContextSize: number;
  /** Maximum number of auto-compactions allowed in a single turn. */
  maxCompactionPerTurn: number;
  /**
   * Consecutive provider-overflow recoveries (overflow -> compact -> overflow
   * again) allowed in a single turn before giving up. Caps the loop when
   * compaction can no longer shrink the request below the model window.
   */
  maxOverflowCompactionAttempts: number;
}

/**
 * Auto-compact at 85% of the resolved context window. `blockRatio` matches
 * `triggerRatio` so compaction runs synchronously with no background
 * compaction.
 */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerRatio: 0.85,
  blockRatio: 0.85,
  reservedContextSize: 50_000,
  maxCompactionPerTurn: Infinity,
  maxOverflowCompactionAttempts: 3,
};

export interface CompactionStrategy {
  shouldCompact(usedSize: number): boolean;
  shouldBlock(usedSize: number): boolean;
  readonly checkAfterStep: boolean;
  readonly maxCompactionPerTurn: number;
  readonly maxOverflowCompactionAttempts: number;
}

export class DefaultCompactionStrategy implements CompactionStrategy {
  constructor(
    protected readonly maxSizeProvider: () => number,
    protected readonly config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
  ) {}

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
    const mod = getNativeCompaction();
    if (mod?.nativeComputeCompactCount) {
      const meta = toCompactionMeta(messages);
      const cfg = toCompactionConfig(this.maxSize, this.config);
      return mod.nativeComputeCompactCount(meta, cfg, source === 'manual');
    }
    return this.tsComputeCompactCount(messages, source);
  }

  private tsComputeCompactCount(messages: readonly Message[], source: CompactionSource): number {
    const tokens = messages.map((m) => estimateTokensForMessage(m));

    if (source === 'manual') {
      for (let i = messages.length - 1; i > 0; i--) {
        if (canSplitAfter(messages, i)) {
          return this.fitCompactCountToWindow(messages, tokens, i + 1);
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
      recentSize += tokens[messages.length - recentMessages]!;

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

    return this.fitCompactCountToWindow(messages, tokens, bestN ?? 0);
  }

  reduceCompactOnOverflow(messages: readonly Message[]): number {
    const mod = getNativeCompaction();
    if (mod?.nativeReduceCompactOnOverflow) {
      const meta = toCompactionMeta(messages);
      const cfg = toCompactionConfig(this.maxSize, this.config);
      return mod.nativeReduceCompactOnOverflow(meta, cfg);
    }
    return this.tsReduceCompactOnOverflow(messages);
  }

  private tsReduceCompactOnOverflow(messages: readonly Message[]): number {
    const tokens = messages.map((m) => estimateTokensForMessage(m));
    const minReducedSize = Math.max(
      1,
      Math.ceil(this.maxSize * this.config.minOverflowReductionRatio),
    );
    let reducedSize = 0;
    let bestN: number | undefined;

    for (let i = messages.length - 2; i > 0; i--) {
      reducedSize += tokens[i + 1]!;
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
    tokens: readonly number[],
    compactedCount: number,
  ): number {
    if (this.maxSize <= 0 || compactedCount <= 0) {
      return compactedCount;
    }

    let compactedSize = 0;
    for (let i = 0; i < compactedCount; i++) {
      compactedSize += tokens[i]!;
    }
    if (compactedSize <= this.maxSize) {
      return compactedCount;
    }

    let bestN: number | undefined;
    for (let n = compactedCount - 1; n > 0; n--) {
      compactedSize -= tokens[n]!;
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

export type { CompactionSource };
