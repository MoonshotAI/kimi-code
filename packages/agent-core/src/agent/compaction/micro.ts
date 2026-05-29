import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import type { ContextMessage } from '../context';
import { estimateTokensForContentParts } from '../../utils/tokens';

export interface MicroCompactionConfig {
  keepRecentMessages: number;
  minContentTokens: number;
  cacheMissedThresholdMs: number;
  truncatedMarker: string;
}

const DEFAULT_CONFIG: MicroCompactionConfig = {
  keepRecentMessages: 10,
  minContentTokens: 100,
  cacheMissedThresholdMs: 60 * 60 * 1000,
  truncatedMarker: '[Old tool result content cleared]',
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

  reset(): void {
    this.cutoff = 0;
  }

  compact(messages: readonly ContextMessage[]): ContextMessage[] {
    const cacheMissed =
      Date.now() - this.agent.context.lastAssistantAt >= this.config.cacheMissedThresholdMs;
    if (cacheMissed) {
      this.cutoff = Math.max(0, messages.length - this.config.keepRecentMessages);
    }

    const result: ContextMessage[] = [];
    let i = 0;
    for (const msg of messages) {
      if (
        i < this.cutoff &&
        msg.role === 'tool' &&
        msg.toolCallId !== undefined &&
        estimateTokensForContentParts(msg.content) >= this.config.minContentTokens
      ) {
        result.push({
          ...msg,
          content: [{ type: 'text', text: this.config.truncatedMarker } satisfies ContentPart],
        });
      } else {
        result.push(msg);
      }
      i++;
    }
    return result;
  }
}
