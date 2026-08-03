import type { Agent } from '..';
import type { ContextMessage } from '../context';

export interface MicroCompactionConfig {
  keepRecentMessages: number;
  minContentTokens: number;
  cacheMissedThresholdMs: number;
  truncatedMarker: string;
  minContextUsageRatio: number;
}

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 20,
  minContentTokens: 100,
  cacheMissedThresholdMs: 60 * 60 * 1000,
  truncatedMarker: '[Old tool result content cleared]',
  minContextUsageRatio: 0.5,
};

export class MicroCompaction {
  private cutoff = 0;
  readonly config: MicroCompactionConfig;

  constructor(
    public readonly agent: Agent,
    config?: Partial<MicroCompactionConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  reset(maxCutoff = 0): void {
    this.cutoff = Math.min(this.cutoff, maxCutoff);
  }

  apply(cutoff: number): void {
    this.agent.records.logRecord({
      type: 'micro_compaction.apply',
      cutoff,
    });
    this.cutoff = cutoff;
  }

  detect(): void {
    // Micro compaction is disabled: the `micro_compaction` experimental flag has
    // been removed from the registry, so detection is intentionally a no-op.
  }

  compact(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    // Micro compaction is disabled: the `micro_compaction` experimental flag has
    // been removed from the registry, so messages are always returned unchanged.
    return messages;
  }
}
