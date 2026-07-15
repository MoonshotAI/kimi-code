import {
  estimateTokensForMessage,
  estimateTokensForMessages,
} from "#/_base/utils/tokens";
import { isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  APIEmptyResponseError,
  APIStatusError,
} from '#/app/llmProtocol/errors';
import type { LLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import type { Message } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';

export const COMPACTION_OVERFLOW_SHRINK_RATIOS = [0.7, 0.5, 0.35] as const;

export interface CompactionAttemptResult {
  readonly summary: string;
  readonly usage: TokenUsage | null;
}

export class CompactionTruncatedError extends Error {
  constructor() {
    super('Compaction response was truncated before producing a complete summary.');
    this.name = 'CompactionTruncatedError';
  }
}

export function findAPIStatusError(error: unknown): APIStatusError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (current instanceof APIStatusError) return current;
    seen.add(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

export function collectSummary(finish: LLMRequestFinish): CompactionAttemptResult {
  if (finish.providerFinishReason === 'truncated') {
    throw new CompactionTruncatedError();
  }

  const summary = finish.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  if (summary.length === 0) {
    throw new APIEmptyResponseError(
      'The compaction response did not contain a non-empty summary.',
    );
  }

  return { summary, usage: finish.usage };
}

export function historySafeToCompact(
  current: readonly ContextMessage[],
  original: readonly ContextMessage[],
): boolean {
  if (current.length < original.length) return false;
  if (!original.every((message, index) => message === current[index])) return false;
  return current.slice(original.length).every(isRealUserInput);
}

export function shrinkCompactionHistoryAfterOverflow<T extends Message>(
  messages: readonly T[],
  attempt: number,
): T[] {
  if (messages.length <= 1) return messages.slice();
  const ratio = COMPACTION_OVERFLOW_SHRINK_RATIOS[
    Math.min(attempt - 1, COMPACTION_OVERFLOW_SHRINK_RATIOS.length - 1)
  ]!;
  const tokenBudget = Math.floor(estimateTokensForMessages(messages) * ratio);
  return takeRecentMessagesWithinTokenBudget(messages, tokenBudget);
}

function takeRecentMessagesWithinTokenBudget<T extends Message>(
  messages: readonly T[],
  tokenBudget: number,
): T[] {
  let start = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateTokensForMessage(messages[i]!);
    if (tokens + messageTokens > tokenBudget) break;
    tokens += messageTokens;
    start = i;
  }
  if (start === 0) start = 1;
  return dropLeadingToolResults(messages.slice(start));
}

export function dropOldestMessageAndLeadingToolResults<T extends { readonly role: string }>(
  messages: readonly T[],
): T[] {
  if (messages.length <= 1) return messages.slice();
  return dropLeadingToolResults(messages.slice(1));
}

function dropLeadingToolResults<T extends { readonly role: string }>(messages: readonly T[]): T[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role === 'tool') {
    start += 1;
  }
  return messages.slice(start);
}
