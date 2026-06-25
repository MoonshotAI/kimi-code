import { estimateTokens, estimateTokensForMessage } from '../../utils/tokens';
import summaryPrefixTemplate from './compaction-summary-prefix.md?raw';

/**
 * "Memento" compaction helpers.
 *
 * Compaction rewrites the model context as: the most recent user messages
 * (verbatim, within a token budget) followed by a single user-role summary
 * that is prefixed with `COMPACTION_SUMMARY_PREFIX`. Assistant messages,
 * tool calls, and tool results are dropped. These helpers apply the exact
 * same rule for both the live context rewrite and the transcript reducer.
 */

export const COMPACTION_SUMMARY_PREFIX = summaryPrefixTemplate.trimEnd();
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

interface ContentPartLike {
  readonly type: string;
  readonly text?: string;
}

interface MessageLike {
  readonly role: string;
  readonly content: readonly ContentPartLike[];
  readonly origin?: { readonly kind: string; readonly trigger?: string } | undefined;
}

function extractText(content: readonly ContentPartLike[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
    }
  }
  return text;
}

export function isCompactionSummaryMessage(message: MessageLike): boolean {
  if (message.origin?.kind === 'compaction_summary') return true;
  return extractText(message.content).startsWith(`${COMPACTION_SUMMARY_PREFIX}\n`);
}

/**
 * Keep only genuine user input (real user prompts and user-slash skill
 * activations). Injections (system reminders, plan-mode reminders),
 * background-task notifications, system triggers, cron/hook/retry messages,
 * and previous compaction summaries are excluded — they are either
 * re-injected each turn or ephemeral, since initial context is rebuilt
 * every turn.
 */
export function isRealUserInput(message: MessageLike): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') return origin.trigger === 'user-slash';
  return false;
}

export function collectCompactableUserMessages<T extends MessageLike>(messages: readonly T[]): T[] {
  return messages.filter(
    (message) => isRealUserInput(message) && !isCompactionSummaryMessage(message),
  );
}

function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  let end = Math.min(text.length, maxTokens * 4);
  while (end > 0 && estimateTokens(text.slice(0, end)) > maxTokens) {
    end--;
  }
  return text.slice(0, end);
}

function truncateUserMessage<T extends MessageLike>(message: T, maxTokens: number): T {
  const text = truncateTextToTokens(extractText(message.content), maxTokens);
  return {
    ...message,
    content: [{ type: 'text', text }],
    toolCalls: [],
  } as unknown as T;
}

/**
 * Keep the most recent user messages whose cumulative estimated size fits
 * `maxTokens`. The oldest kept message is truncated to the remaining budget
 * when it would otherwise overflow; older messages are dropped.
 */
export function selectRecentUserMessages<T extends MessageLike>(
  messages: readonly T[],
  maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS,
): T[] {
  const selected: T[] = [];
  let remaining = maxTokens;
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messages[i]!;
    const tokens = estimateTokensForMessage(message as never);
    if (tokens <= remaining) {
      selected.push(message);
      remaining -= tokens;
    } else {
      selected.push(truncateUserMessage(message, remaining));
      break;
    }
  }
  selected.reverse();
  return selected;
}

export function buildCompactionSummaryText(summary: string): string {
  const suffix = summary.trim();
  return `${COMPACTION_SUMMARY_PREFIX}\n${suffix.length > 0 ? suffix : '(no summary available)'}`;
}
