import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import type { ContextMessage } from '../context';
import {
  estimateTokensForContentParts,
  estimateTokensForMessages,
} from '../../utils/tokens';

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
    if (!this.agent.experimentalFlags.enabled('micro_compaction')) return;

    const config = this.config;
    const { history, lastAssistantAt } = this.agent.context;
    const cacheAgeMs = lastAssistantAt === null ? null : Date.now() - lastAssistantAt;
    const cacheMissed = cacheAgeMs !== null && cacheAgeMs >= config.cacheMissedThresholdMs;
    if (!cacheMissed) return;

    const maxContextTokens = this.agent.config.modelCapabilities.max_context_tokens;
    const contextTokens = this.agent.context.tokenCountWithPending;
    const contextUsageRatio =
      maxContextTokens !== undefined && maxContextTokens > 0
        ? contextTokens / maxContextTokens
        : 1;
    if (contextUsageRatio < config.minContextUsageRatio) return;

    const previousCutoff = this.cutoff;
    const nextCutoff = Math.max(0, history.length - config.keepRecentMessages);
    this.apply(nextCutoff);
    if (previousCutoff !== nextCutoff) {
      const effect = this.measureEffect(history, nextCutoff);
      const previousEffect = this.measureEffect(history, previousCutoff);
      const rawContextTokens = estimateTokensForMessages(history);
      // Whole-context length before/after this cutoff change, mirroring the
      // `tokensBefore`/`tokensAfter` fields on `compaction_finished` so the
      // two compaction paths can be compared on the same axis.
      const tokensBefore =
        rawContextTokens -
        previousEffect.truncatedToolResultTokensBefore +
        previousEffect.truncatedToolResultTokensAfter;
      const tokensAfter =
        rawContextTokens -
        effect.truncatedToolResultTokensBefore +
        effect.truncatedToolResultTokensAfter;
      this.agent.telemetry.track('micro_compaction_finished', {
        ...config,
        ...effect,
        tokensBefore,
        tokensAfter,
        previous_cutoff: previousCutoff,
        cutoff: nextCutoff,
        message_count: history.length,
        cache_age_ms: cacheAgeMs,
      });
    }
  }

  compact(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    if (!this.agent.experimentalFlags.enabled('micro_compaction')) return messages;

    const config = this.config;
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
    let truncatedToolResultTokensBefore = 0;
    let truncatedToolResultTokensAfter = 0;
    for (let i = 0; i < messages.length && i < cutoff; i++) {
      const message = messages[i];
      if (message?.role !== 'tool' || message.toolCallId === undefined) continue;

      const contentTokens = estimateTokensForContentParts(message.content);
      if (contentTokens < this.config.minContentTokens) continue;

      markerTokenCount ??= estimateTokensForContentParts([
        { type: 'text', text: this.config.truncatedMarker },
      ]);
      truncatedToolResultCount += 1;
      truncatedToolResultTokensBefore += contentTokens;
      truncatedToolResultTokensAfter += markerTokenCount;
    }
    return {
      truncatedToolResultCount,
      truncatedToolResultTokensBefore,
      truncatedToolResultTokensAfter,
    };
  }
}
