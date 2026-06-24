import type { Message } from '@moonshot-ai/kosong';

import {
  DEFAULT_COMPACTION_CONFIG,
  DefaultCompactionStrategy,
  type CompactionConfig,
  type CompactionSource,
  type CompactionStrategy,
} from '../../../agent/compaction';
import type { ProfileModelContext } from '../profile/profile';

export class RuntimeCompactionStrategy implements CompactionStrategy {
  constructor(private readonly context: () => ProfileModelContext) {}

  shouldCompact(usedSize: number): boolean {
    return this.delegate().shouldCompact(usedSize);
  }

  shouldBlock(usedSize: number): boolean {
    return this.delegate().shouldBlock(usedSize);
  }

  computeCompactCount(messages: readonly Message[], source: CompactionSource): number {
    return this.delegate().computeCompactCount(messages, source);
  }

  reduceCompactOnOverflow(messages: readonly Message[]): number {
    return this.delegate().reduceCompactOnOverflow(messages);
  }

  get checkAfterStep(): boolean {
    return this.config().triggerRatio !== this.config().blockRatio;
  }

  get maxCompactionPerTurn(): number {
    return this.config().maxCompactionPerTurn;
  }

  private delegate(): DefaultCompactionStrategy {
    const model = this.context();
    return new DefaultCompactionStrategy(
      () => model.modelCapabilities.max_context_tokens,
      this.config(model),
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
