import type { CompactionSource } from './types';

export interface CompactionConfig {
  /** Fraction of the model context window that triggers auto-compaction. */
  triggerRatio: number;
  /** Fraction of the model context window that blocks the turn on compaction. */
  blockRatio: number;
  /** Reserved output budget; compaction triggers early to leave this much room. */
  reservedContextSize: number;
  /** Maximum number of auto-compactions allowed in a single turn. */
  maxCompactionPerTurn: number;
}

/**
 * Auto-compact at 90% of the resolved context window. `blockRatio` matches
 * `triggerRatio` so compaction runs synchronously with no background
 * compaction.
 */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerRatio: 0.9,
  blockRatio: 0.9,
  reservedContextSize: 50_000,
  maxCompactionPerTurn: Infinity,
};

export interface CompactionStrategy {
  shouldCompact(usedSize: number): boolean;
  shouldBlock(usedSize: number): boolean;
  readonly checkAfterStep: boolean;
  readonly maxCompactionPerTurn: number;
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

  get checkAfterStep(): boolean {
    return this.config.triggerRatio !== this.config.blockRatio;
  }

  get maxCompactionPerTurn(): number {
    return this.config.maxCompactionPerTurn;
  }
}

export type { CompactionSource };
