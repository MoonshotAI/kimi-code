import type { Message } from "@moonshot-ai/kosong";
import { estimateTokensForMessage } from "../../utils/tokens";
import { type CompactionConfig, DEFAULT_COMPACTION_CONFIG } from "./config";

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
