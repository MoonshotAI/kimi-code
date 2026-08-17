/**
 * `contextMemory` domain helper — owns the v1-compatible full-compaction
 * shape vocabulary: the marker message the fold appends, the read-time
 * window derivation, and the live metadata computation.
 *
 * Token budgeting runs through an injectable {@link TokenEstimate}: the live
 * path (`AgentContextMemoryService.applyCompaction`) passes the estimator
 * from `IAgentTokenCountingService` (the raw heuristics — the
 * `[token_counting]` strategy never gates internal estimates); the pure
 * wire-replay / reducer paths keep the same heuristics — their estimate
 * fallback only fires when a record lacks `tokensAfter`, so the measured
 * chain is unaffected.
 *
 * The result layout is `[kept user messages…, elision?, summary]` (legacy
 * records: `[summary, …tail]`). `buildContextCompactionShape` computes the
 * new-style layout eagerly for the live metadata path (its callers never
 * produce a legacy shape — `ContextCompactionInput` carries no `legacyTail`);
 * `createCompactionMarkerMessage` + `deriveCompactionWindow` are its
 * append-only counterparts — the fold appends the marker verbatim and
 * `visibleWindow` re-derives the same layout at read time, including the
 * legacy tail layout when replaying legacy records, so a layout change still
 * lands in this one file.
 * `compactionResultMessageCount` is the read-side mirror for projections that
 * need only the length (the display transcript's `foldedLength`).
 */

import { estimateTokens, estimateTokensForMessage, estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { ContentPart } from '#/kosong/contract/message';
import { wrapSystemReminder } from '#/agent/systemReminder/systemReminder';
import summaryPrefixTemplate from './compaction-summary-prefix.md?raw';
import type { CompactionMeta, ContextMessage, PromptOrigin } from './types';

export const COMPACTION_SUMMARY_PREFIX = summaryPrefixTemplate.trimEnd();
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const COMPACT_USER_MESSAGE_HEAD_TOKENS = 2_000;
export const COMPACTION_ELISION_VARIANT = 'compaction_elision';

type MessageLike = ContextMessage;

/** Injectable token-count estimates; see the file header for who passes what. */
export interface TokenEstimate {
  readonly text: (text: string) => number;
  readonly message: (message: MessageLike) => number;
  readonly messages: (messages: readonly MessageLike[]) => number;
}

export const defaultTokenEstimate: TokenEstimate = {
  text: estimateTokens,
  message: estimateTokensForMessage,
  messages: estimateTokensForMessages,
};

export interface CompactionUserSelection<T> {
  readonly head: T[];
  readonly tail: T[];
  readonly elided: boolean;
  readonly omittedTokens: number;
}

export interface ContextCompactionShapeInput {
  readonly summary: string;
  readonly legacySummaryMessage?: ContextMessage;
  readonly contextSummary?: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter?: number;
  /** Measured output tokens of the compaction LLM exchange — the REAL size of
   *  the generated summary. Preferred over the summary-text estimate in the
   *  `tokensAfter` fallback when present. */
  readonly summaryOutputTokens?: number;
  /** Estimated fixed request overhead (system prompt + non-deferred tool
   *  schemas) surviving the compaction; counted into the `tokensAfter`
   *  fallback so the result stays on the same full-request basis as the
   *  measured exchange anchors. Live path only — replay reads the persisted
   *  `tokensAfter` verbatim. */
  readonly requestOverheadTokens?: number;
  readonly keptUserMessageCount?: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
  readonly legacyTail?: boolean;
}

export interface ContextCompactionShape {
  readonly summary: string;
  readonly contextSummary: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly keptUserMessageCount: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
  readonly messages: readonly ContextMessage[];
}

export function buildContextCompactionShape(
  history: readonly ContextMessage[],
  input: ContextCompactionShapeInput,
  estimate: TokenEstimate = defaultTokenEstimate,
): ContextCompactionShape {
  const compactableUserMessages = collectCompactableUserMessages(history);
  const selection = selectCompactionUserMessages(
    compactableUserMessages,
    COMPACT_USER_MESSAGE_MAX_TOKENS,
    COMPACT_USER_MESSAGE_HEAD_TOKENS,
    estimate.message,
  );
  const elisionMessage = selection.elided
    ? createCompactionElisionMessage(selection.omittedTokens)
    : undefined;
  const keptMessages = elisionMessage === undefined
    ? [...selection.head, ...selection.tail]
    : [...selection.head, elisionMessage, ...selection.tail];
  const contextSummary = input.contextSummary ?? input.summary;
  const tokensAfter =
    input.tokensAfter ??
    (input.requestOverheadTokens ?? 0) +
      (input.summaryOutputTokens ?? estimate.text(contextSummary)) +
      estimate.messages(keptMessages);
  const keptUserMessageCount =
    input.keptUserMessageCount ?? selection.head.length + selection.tail.length;
  const keptHeadUserMessageCount =
    input.keptHeadUserMessageCount ?? (selection.elided ? selection.head.length : undefined);

  return {
    summary: input.summary,
    contextSummary,
    compactedCount: input.compactedCount,
    tokensBefore: input.tokensBefore,
    tokensAfter,
    keptUserMessageCount,
    keptHeadUserMessageCount,
    droppedCount: input.droppedCount,
    messages: [...keptMessages, createCompactionSummaryMessage(contextSummary)],
  };
}

export function compactionResultMessageCount(
  keptUserMessageCount: number | undefined,
  keptHeadUserMessageCount: number | undefined,
): number | undefined {
  if (keptUserMessageCount === undefined) return undefined;
  return keptUserMessageCount + (keptHeadUserMessageCount === undefined ? 1 : 2);
}

/**
 * The message the `context.apply_compaction` fold appends: the summary
 * message the destructive rewrite used to synthesize, plus the record fields
 * mirrored as {@link CompactionMeta} so the append-only log stays
 * self-describing. Legacy records carrying a verbatim summary message keep it
 * (meta attached) exactly as the rewrite kept it.
 */
export function createCompactionMarkerMessage(input: ContextCompactionShapeInput): ContextMessage {
  const meta: CompactionMeta = {
    compactedCount: input.compactedCount,
    tokensBefore: input.tokensBefore,
    tokensAfter: input.tokensAfter,
    summaryOutputTokens: input.summaryOutputTokens,
    keptUserMessageCount: input.keptUserMessageCount,
    keptHeadUserMessageCount: input.keptHeadUserMessageCount,
    droppedCount: input.droppedCount,
    legacyTail: input.legacyTail === true ? true : undefined,
  };
  const base =
    usesLegacyTailShape(input) && input.legacySummaryMessage !== undefined
      ? input.legacySummaryMessage
      : createCompactionSummaryMessage(input.contextSummary ?? input.summary);
  return { ...base, compaction: meta };
}

/**
 * Read-time counterpart of {@link buildContextCompactionShape}: folds one
 * marker into the pre-compaction visible `window`, returning the new visible
 * window. The marker enters the window stripped of its `CompactionMeta` (the
 * meta is log bookkeeping, not conversation content), making the result
 * byte-identical to what the destructive rewrite produced. Selection is
 * re-derived deterministically from the window — the media-flat token
 * heuristics make it dehydrate/rehydrate-invariant, and the persisted
 * kept-user counts stay informational.
 */
export function deriveCompactionWindow(
  window: readonly ContextMessage[],
  marker: ContextMessage,
): readonly ContextMessage[] {
  const meta = marker.compaction;
  const summary = stripCompactionMeta(marker);
  if (meta?.legacyTail === true) {
    return [summary, ...window.slice(meta.compactedCount)];
  }
  const selection = selectCompactionUserMessages(
    collectCompactableUserMessages(window),
    COMPACT_USER_MESSAGE_MAX_TOKENS,
    COMPACT_USER_MESSAGE_HEAD_TOKENS,
    defaultTokenEstimate.message,
  );
  const elision = selection.elided
    ? createCompactionElisionMessage(selection.omittedTokens)
    : undefined;
  return elision === undefined
    ? [...selection.head, ...selection.tail, summary]
    : [...selection.head, elision, ...selection.tail, summary];
}

function stripCompactionMeta(message: ContextMessage): ContextMessage {
  if (message.compaction === undefined) return message;
  const { compaction: _meta, ...stripped } = message;
  void _meta;
  return stripped;
}

export function buildCompactionSummaryText(summary: string): string {
  const suffix = summary.trim();
  return `${COMPACTION_SUMMARY_PREFIX}\n${suffix.length > 0 ? suffix : '(no summary available)'}`;
}

export function createCompactionSummaryMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

export function createCompactionElisionMessage(omittedTokens: number): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: buildCompactionElisionText(omittedTokens) }],
    toolCalls: [],
    origin: { kind: 'injection', variant: COMPACTION_ELISION_VARIANT },
  };
}

export function buildCompactionElisionText(omittedTokens: number): string {
  return wrapSystemReminder(
    `Some of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly ${String(omittedTokens)} tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation.`,
  );
}

export function collectCompactableUserMessages<T extends MessageLike>(messages: readonly T[]): T[] {
  return messages.filter(
    (message) => isRealUserInput(message) && !isCompactionSummaryMessage(message),
  );
}

export function isCompactionSummaryMessage(message: MessageLike): boolean {
  return message.origin?.kind === 'compaction_summary';
}

export function isRealUserInput(message: MessageLike): boolean {
  return message.role === 'user' && compactionUserMessageDisposition(message.origin) === 'keep';
}

export function compactionUserMessageDisposition(
  origin: PromptOrigin | undefined,
): 'keep' | 'drop' {
  if (origin === undefined) return 'keep';
  switch (origin.kind) {
    case 'user':
      return 'keep';
    case 'skill_activation':
    case 'plugin_command':
      return origin.trigger === 'user-slash' ? 'keep' : 'drop';
    case 'injection':
    case 'shell_command':
    case 'compaction_summary':
    case 'system_trigger':
    case 'task':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'retry':
      return 'drop';
    default: {
      const exhaustive: never = origin;
      void exhaustive;
      return 'drop';
    }
  }
}

export function selectRecentUserMessages<T extends MessageLike>(
  messages: readonly T[],
  maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): T[] {
  const selected: T[] = [];
  let remaining = maxTokens;
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messages[i]!;
    const tokens = estimateMessage(message);
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

export function selectCompactionUserMessages<T extends MessageLike>(
  messages: readonly T[],
  maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS,
  headTokens: number = COMPACT_USER_MESSAGE_HEAD_TOKENS,
  estimateMessage: (message: T) => number = estimateTokensForMessage,
): CompactionUserSelection<T> {
  let totalTokens = 0;
  for (const message of messages) {
    totalTokens += estimateMessage(message);
  }
  if (totalTokens <= maxTokens) {
    return { head: [], tail: [...messages], elided: false, omittedTokens: 0 };
  }

  const headBudget = Math.min(Math.max(headTokens, 0), maxTokens);
  const tailBudget = maxTokens - headBudget;
  const tail: T[] = [];
  let tailRemaining = tailBudget;
  let headEndExclusive = messages.length;
  let tailBoundaryDroppedPrefix: T | null = null;
  for (let i = messages.length - 1; i >= 0 && tailRemaining > 0; i--) {
    const message = messages[i]!;
    const tokens = estimateMessage(message);
    if (tokens <= tailRemaining) {
      tail.push(message);
      tailRemaining -= tokens;
      headEndExclusive = i;
      continue;
    }
    const fullText = extractText(message.content);
    const keptSuffix = truncateTextToTokensFromEnd(fullText, tailRemaining);
    tail.push(replaceMessageText(message, keptSuffix));
    headEndExclusive = i;
    const droppedPrefix = fullText.slice(0, fullText.length - keptSuffix.length);
    if (droppedPrefix.length > 0) {
      tailBoundaryDroppedPrefix = replaceMessageText(message, droppedPrefix);
    }
    break;
  }
  tail.reverse();

  const headCandidates = messages.slice(0, headEndExclusive);
  if (tailBoundaryDroppedPrefix !== null) {
    headCandidates.push(tailBoundaryDroppedPrefix);
  }
  const head: T[] = [];
  let headRemaining = headBudget;
  for (const message of headCandidates) {
    if (headRemaining <= 0) break;
    const tokens = estimateMessage(message);
    if (tokens <= headRemaining) {
      head.push(message);
      headRemaining -= tokens;
      continue;
    }
    head.push(truncateUserMessage(message, headRemaining));
    break;
  }

  let keptTokens = 0;
  for (const message of head) keptTokens += estimateMessage(message);
  for (const message of tail) keptTokens += estimateMessage(message);
  return { head, tail, elided: true, omittedTokens: Math.max(0, totalTokens - keptTokens) };
}

function usesLegacyTailShape(input: ContextCompactionShapeInput): boolean {
  return input.legacyTail === true;
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

function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
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

function truncateTextToTokensFromEnd(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let start = text.length;
  for (let i = text.length - 1; i >= 0; i--) {
    let isAscii = false;
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const high = text.charCodeAt(i - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        i--;
      }
    } else {
      isAscii = code <= 127;
    }
    if (isAscii) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    start = i;
  }
  return text.slice(start);
}

function replaceMessageText<T extends MessageLike>(message: T, text: string): T {
  return {
    ...message,
    content: [{ type: 'text', text }],
    toolCalls: [],
  } as unknown as T;
}

function truncateUserMessage<T extends MessageLike>(message: T, maxTokens: number): T {
  return replaceMessageText(message, truncateTextToTokens(extractText(message.content), maxTokens));
}
