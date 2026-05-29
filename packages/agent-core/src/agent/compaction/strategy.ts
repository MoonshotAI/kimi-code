import type { Message } from "@moonshot-ai/kosong";
import { estimateTokensForMessage } from "../../utils/tokens";
import type { CompactionSource } from "./types";

export interface CompactionConfig {
  triggerRatio: number;
  blockRatio: number;
  reservedContextSize: number;
  maxCompactionPerTurn: number;
  maxRecentMessages: number;
  maxRecentUserMessages: number;
  maxRecentSizeRatio: number;
  minOverflowReductionRatio: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerRatio: 0.85,
  blockRatio: 0.85, // Same as triggerRatio to disable async compaction
  reservedContextSize: 50_000,
  maxCompactionPerTurn: 3,
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
    // Return value: N messages to be compacted (0 means no compaction possible)
    // LLM Input: messages.slice(0, N) + [user:instruction]
    // Preserved recent messages: messages.slice(N)

    // Manual compaction
    if (source === 'manual') {
      for (let i = messages.length - 1; i > 0; i--) {
        if (canSplitAfter(messages, i)) {
          return i + 1;
        }
      }
      return 0;
    }

    // Auto compaction rules (in order of precedence):
    // 1. The split after messages[N-1] must be safe per `canSplitAfter`:
    //    messages[N-1] is not a user or asst-with-tool-calls, and the retained
    //    suffix messages.slice(N) has no orphan tool result.
    // 2. At least one recent message must be preserved
    // 3. At most maxRecentMessages recent messages should be preserved
    // 4. At most maxRecentUserMessages recent user messages should be preserved
    // 5. At most maxRecentSizeRatio * maxSize recent messages should be preserved
    // 6. N should be as small as possible

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

    return bestN ?? 0;
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

  get checkAfterStep(): boolean {
    return this.config.triggerRatio !== this.config.blockRatio;
  }

  get maxCompactionPerTurn(): number {
    return this.config.maxCompactionPerTurn;
  }
}

/**
 * Decide whether a compaction split is safe to place immediately after
 * `messages[index]`. A split is safe only when:
 *   - `messages[index]` itself is not a user message or an assistant message
 *     with pending tool calls (cutting either of those off from what follows
 *     would break the conversation), AND
 *   - the next message is not a tool result. The history is well-formed:
 *     tool results only appear after their owning `asst_w_tc` and all tool
 *     results for one exchange land consecutively before the next non-tool
 *     message. So if the suffix starts with a tool result, its `asst_w_tc`
 *     must be in the compacted prefix, which would orphan that result
 *     (e.g. splitting between tool_a and tool_b of a parallel call).
 */
function canSplitAfter(messages: readonly Message[], index: number): boolean {
  const m = messages[index];
  if (m === undefined) return false;
  if (m.role === 'user') return false;
  if (m.role === 'assistant' && m.toolCalls.length > 0) return false;
  if (messages[index + 1]?.role === 'tool') return false;
  return true;
}
