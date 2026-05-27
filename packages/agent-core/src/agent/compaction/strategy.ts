import type { Message } from "@moonshot-ai/kosong";
import { estimateTokensForMessage } from "../../utils/tokens";

export interface CompactionConfig {
  triggerRatio: number;
  blockRatio: number;
  reservedContextSize: number;
  maxCompactionPerTurn: number;
  maxRecentMessages: number;
  maxRecentUserMessages: number;
  maxRecentSizeRatio: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerRatio: 0.85,
  blockRatio: 0.85, // Same as triggerRatio to disable async compaction
  reservedContextSize: 50_000,
  maxCompactionPerTurn: 3,
  maxRecentMessages: 4,
  maxRecentUserMessages: Infinity,
  maxRecentSizeRatio: 0.2,
};

export interface CompactionStrategy {
  shouldCompact(usedSize: number): boolean;
  shouldBlock(usedSize: number): boolean;
  computeCompactCount(messages: readonly Message[]): number;
  reduceCompactOnOverflow(messages: readonly Message[]): number;
  readonly checkAfterStep: boolean;
  readonly maxCompactionPerTurn: number;
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

  computeCompactCount(messages: readonly Message[]): number {
    // Return value: N messages to be compacted
    // LLM Input: messages.slice(0, N) + [user:instruction]
    // Preserved recent messages: messages.slice(N)
    //
    // Rules (in order of precedence):
    // 1. messages[N-1] must not be a user message or assistant message with tool calls
    // 2. At least one recent message must be preserved
    // 3. At most maxRecentMessages recent messages should be preserved
    // 4. At most maxRecentUserMessages recent user messages should be preserved
    // 5. At most maxRecentSizeRatio * maxSize recent messages should be preserved
    // 6. N should be as small as possible

    let recentMessages = 1;
    let recentUserMessages = 0;
    let recentSize = 0;

    for (; recentMessages < messages.length; recentMessages++) {
      const m1 = messages[messages.length - recentMessages - 1]!;
      const m2 = messages[messages.length - recentMessages]!;

      recentMessages++;
      if (m2.role === 'user') {
        recentUserMessages++;
      }
      recentSize += estimateTokensForMessage(m2);

      const reachesMax = recentMessages >= this.config.maxRecentMessages
        || recentUserMessages >= this.config.maxRecentUserMessages
        || recentSize >= this.maxSize * this.config.maxRecentSizeRatio;
      if (!cannotSplitAfter(m1) && reachesMax) {
        return messages.length - recentMessages;
      }
    }

    throw new Error('Unable to compact messages: all messages are too recent or cannot be split');
  }

  reduceCompactOnOverflow(messages: readonly Message[]): number {
    for (let i = messages.length - 2; i > 0; i--) {
      if (!cannotSplitAfter(messages[i]!)) {
        return i + 1;
      }
    }
    return messages.length;
  }

  get checkAfterStep(): boolean {
    return this.config.triggerRatio !== this.config.blockRatio;
  }

  get maxCompactionPerTurn(): number {
    return this.config.maxCompactionPerTurn;
  }
}

function cannotSplitAfter(message: Message): boolean {
  return message.role === 'user' || (message.role === 'assistant' && message.toolCalls.length > 0);
}
