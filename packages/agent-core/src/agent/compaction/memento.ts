import type { ContentPart } from '@moonshot-ai/kosong';
import { estimateTokensForMessage } from '../../utils/tokens';
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

/**
 * Structural subset of kosong's `Message` that the memento helpers inspect.
 * Both `ContextMessage` (the live context) and the wire-transcript reducer's
 * mutable message satisfy this shape, so one set of helpers serves both
 * layers without introducing a shared nominal type. `origin` is what tells
 * real user input apart from injections and compaction summaries.
 */
interface MessageLike {
  readonly role: string;
  readonly content: readonly ContentPart[];
  readonly origin?: { readonly kind: string; readonly trigger?: string } | undefined;
}

function extractText(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') {
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
  // Single pass: walk the string once, mirroring estimateTokens' heuristic
  // (ASCII ~4 chars/token, non-ASCII ~1 char/token) and stop at the first
  // code point that would push the running total over the budget. This keeps
  // CJK-heavy inputs from the O(n^2) cost of re-estimating shrinking prefixes.
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let end = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    end += char.length;
  }
  return text.slice(0, end);
}

function truncateUserMessage<T extends MessageLike>(message: T, maxTokens: number): T {
  const text = truncateTextToTokens(extractText(message.content), maxTokens);
  // Spread the original message to preserve every field (notably `origin`),
  // then replace the content with the truncated text and drop any tool calls.
  // Real user input never carries tool calls, so clearing them is safe. The
  // cast back to `T` is unavoidable here: TypeScript cannot prove that a
  // spread-then-override shape still equals the generic `T`.
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
    const tokens = estimateTokensForMessage(message);
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
