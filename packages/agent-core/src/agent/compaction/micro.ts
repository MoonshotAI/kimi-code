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

  apply(cutoff: number): void {
    this.agent.records.logRecord({
      type: 'micro_compaction.apply',
      cutoff,
    });
    this.cutoff = cutoff;
  }

  compact(messages: readonly ContextMessage[]): ContextMessage[] {
    const config = this.config;
    const { lastAssistantAt } = this.agent.context;
    const cacheAgeMs = lastAssistantAt === null ? null : Date.now() - lastAssistantAt;
    const cacheMissed = cacheAgeMs !== null && cacheAgeMs >= config.cacheMissedThresholdMs;
    if (cacheMissed) {
      const previousCutoff = this.cutoff;
      const nextCutoff = Math.max(0, messages.length - config.keepRecentMessages);
      this.apply(nextCutoff);
      if (previousCutoff !== nextCutoff) {
        const effect = this.measureEffect(messages, nextCutoff);
        this.agent.telemetry.track('micro_compaction_applied', {
          ...config,
          ...effect,
          previous_cutoff: previousCutoff,
          cutoff: nextCutoff,
          message_count: messages.length,
          cache_age_ms: cacheAgeMs,
        });
      }
    }

    const result: ContextMessage[] = [];
    let i = 0;
    for (const msg of messages) {
      if (
        i < this.cutoff &&
        msg.role === 'tool' &&
        msg.toolCallId !== undefined &&
        estimateTokensForContentParts(msg.content) >= config.minContentTokens
      ) {
        result.push({
          ...msg,
          content: [{ type: 'text', text: config.truncatedMarker } satisfies ContentPart],
        });
      } else {
        result.push(msg);
      }
      i++;
    }
    return result;
  }

  private measureEffect(
    messages: readonly ContextMessage[],
    cutoff: number,
  ) {
    let markerTokenCount: number | undefined;
    let truncatedToolResultCount = 0;
    let beforeTokens = 0;
    let afterTokens = 0;
    for (let i = 0; i < messages.length && i < cutoff; i++) {
      const message = messages[i];
      if (message?.role !== 'tool' || message.toolCallId === undefined) continue;

      const contentTokens = estimateTokensForContentParts(message.content);
      if (contentTokens < this.config.minContentTokens) continue;

      markerTokenCount ??= estimateTokensForContentParts([
        { type: 'text', text: this.config.truncatedMarker },
      ]);
      truncatedToolResultCount += 1;
      beforeTokens += contentTokens;
      afterTokens += markerTokenCount;
    }
    return { truncatedToolResultCount, beforeTokens, afterTokens };
  }
}
