import type { ContentPart } from '@moonshot-ai/kosong';
import { estimateTokensForMessage } from '../../utils/tokens';
import type { PromptOrigin } from '../context/types';
import summaryPrefixTemplate from './compaction-summary-prefix.md?raw';

/**
 * Compaction handoff helpers.
 *
 * Compaction rewrites the model context as: the kept user messages (verbatim,
 * within a token budget) followed by a single user-role summary that is
 * prefixed with `COMPACTION_SUMMARY_PREFIX`. When the user messages exceed the
 * budget, the kept set is a HEAD segment (the oldest
 * `COMPACT_USER_MESSAGE_HEAD_TOKENS`) plus a TAIL segment (the most recent
 * remainder of the budget), with a user-invisible elision marker between them
 * telling the model what was omitted. Assistant messages, tool calls, and tool
 * results are dropped. These helpers apply the exact same rule for both the
 * live context rewrite and the transcript reducer.
 */

export const COMPACTION_SUMMARY_PREFIX = summaryPrefixTemplate.trimEnd();
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
/**
 * Of `COMPACT_USER_MESSAGE_MAX_TOKENS`, the slice reserved for the OLDEST user
 * messages once the pool no longer fits the budget. The earliest prompts
 * usually carry the original task statement, which a tail-only selection
 * would drop entirely.
 */
export const COMPACT_USER_MESSAGE_HEAD_TOKENS = 2_000;

/**
 * `InjectionOrigin.variant` of the elision marker inserted between the head
 * and tail segments. Injection-origin messages are dropped by
 * `compactionUserMessageDisposition` at the next compaction (so markers never
 * stack or get re-summarized) and are skipped on replay/transcript rendering.
 */
export const COMPACTION_ELISION_VARIANT = 'compaction_elision';

/**
 * Structural subset of kosong's `Message` that the handoff helpers inspect.
 * Both `ContextMessage` (the live context) and the wire-transcript reducer's
 * mutable message satisfy this shape, so one set of helpers serves both
 * layers without introducing a shared nominal type. `origin` is what tells
 * real user input apart from injections and compaction summaries.
 */
interface MessageLike {
  readonly role: string;
  readonly content: readonly ContentPart[];
  readonly origin?: PromptOrigin | undefined;
}

export type CompactionUserDisposition = 'keep' | 'drop';

/**
 * Single source of truth for whether a user-role message survives compaction as
 * genuine user input. Only real user prompts and user-slash skill
 * activations are kept verbatim. Everything else user-role is
 * either rebuilt by injectors after compaction or intentionally ephemeral, so
 * it is dropped from the live context even when transcript/replay retains it
 * for UI rendering. New `PromptOrigin` kinds must update this switch.
 */
export function compactionUserMessageDisposition(
  origin: PromptOrigin | undefined,
): CompactionUserDisposition {
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
    case 'background_task':
    case 'cron_job':
    case 'cron_missed':
    case 'hook_result':
    case 'retry':
      return 'drop';
    default: {
      const _exhaustive: never = origin;
      void _exhaustive;
      return 'drop';
    }
  }
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
  return message.origin?.kind === 'compaction_summary';
}

/**
 * Keep only genuine user input (real user prompts and user-slash skill
 * activations). See `compactionUserMessageDisposition` for the full keep/drop
 * policy and the rationale for each origin.
 */
export function isRealUserInput(message: MessageLike): boolean {
  return message.role === 'user' && compactionUserMessageDisposition(message.origin) === 'keep';
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

/**
 * Mirror of `truncateTextToTokens` that keeps the END of the text: walk code
 * points from the last one backward (consuming surrogate pairs whole) and stop
 * at the first one that would push the running total over the budget.
 */
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
        // Supplementary-plane code point: consume both units, always non-ASCII.
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

/**
 * Rebuild a message around new text content. Dropping to text only loses any
 * image/audio/video the message carried: media cannot be partially truncated,
 * and keeping it whole would overshoot the budget, so a boundary message loses
 * its attachments. Messages that fit their budget are kept verbatim (media
 * included); only boundary messages go through here. Spread the original to
 * preserve every field (notably `origin`); clearing tool calls is safe (real
 * user input never carries them). The cast back to `T` is unavoidable:
 * TypeScript cannot prove the spread-then-override still equals T.
 */
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

/**
 * Tail-only selection: keep the most recent user messages whose cumulative
 * estimated size fits `maxTokens`. The oldest kept message is truncated to the
 * remaining budget when it would otherwise overflow; older messages are
 * dropped.
 *
 * This is the selection rule compaction used before the head/tail split.
 * `selectCompactionUserMessages` is the live rule; this one is kept so wire
 * records written before `keptHeadUserMessageCount` existed restore with the
 * exact selection that produced them.
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

export interface CompactionUserSelection<T> {
  /**
   * Oldest user messages kept within the head budget. The newest of them may
   * be truncated to the remaining budget (keeping its beginning) and may be a
   * partial slice of the same original message whose end opens `tail`. Empty
   * when nothing was elided.
   */
  readonly head: T[];
  /**
   * Most recent user messages kept within the remaining budget. The oldest of
   * them may be truncated (keeping its end, which is the more recent part).
   * Holds the whole input verbatim when `elided` is false.
   */
  readonly tail: T[];
  /** True when user content between `head` and `tail` was dropped. */
  readonly elided: boolean;
  /** Estimated tokens of the dropped middle. 0 when `elided` is false. */
  readonly omittedTokens: number;
}

/**
 * Select the user messages compaction keeps verbatim.
 *
 * When the pool fits `maxTokens` it is kept whole. When it does not, the kept
 * set is the first `headTokens` of the pool (oldest messages, boundary
 * truncated keeping its beginning) plus the last `maxTokens - headTokens`
 * (newest messages, boundary truncated keeping its end). The head may extend
 * into the beginning of the same message whose end anchors the tail, so a
 * single oversized message still keeps both its start and its most recent
 * part.
 */
export function selectCompactionUserMessages<T extends MessageLike>(
  messages: readonly T[],
  maxTokens: number = COMPACT_USER_MESSAGE_MAX_TOKENS,
  headTokens: number = COMPACT_USER_MESSAGE_HEAD_TOKENS,
): CompactionUserSelection<T> {
  let totalTokens = 0;
  for (const message of messages) {
    totalTokens += estimateTokensForMessage(message);
  }
  if (totalTokens <= maxTokens) {
    return { head: [], tail: [...messages], elided: false, omittedTokens: 0 };
  }

  const headBudget = Math.min(Math.max(headTokens, 0), maxTokens);
  const tailBudget = maxTokens - headBudget;

  // Tail: newest messages first. The boundary message keeps its END — the
  // budget means "the most recent tokens", and the end of a cut message is
  // more recent than its beginning.
  const tail: T[] = [];
  let tailRemaining = tailBudget;
  let headEndExclusive = messages.length;
  let tailBoundaryDroppedPrefix: T | null = null;
  for (let i = messages.length - 1; i >= 0 && tailRemaining > 0; i--) {
    const message = messages[i]!;
    const tokens = estimateTokensForMessage(message);
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
    // The cut-off beginning of the boundary message is still head-eligible.
    const droppedPrefix = fullText.slice(0, fullText.length - keptSuffix.length);
    if (droppedPrefix.length > 0) {
      tailBoundaryDroppedPrefix = replaceMessageText(message, droppedPrefix);
    }
    break;
  }
  tail.reverse();

  // Head: oldest messages first, over everything the tail did not keep. The
  // boundary message keeps its BEGINNING.
  const headCandidates = messages.slice(0, headEndExclusive);
  if (tailBoundaryDroppedPrefix !== null) {
    headCandidates.push(tailBoundaryDroppedPrefix);
  }
  const head: T[] = [];
  let headRemaining = headBudget;
  for (const message of headCandidates) {
    if (headRemaining <= 0) break;
    const tokens = estimateTokensForMessage(message);
    if (tokens <= headRemaining) {
      head.push(message);
      headRemaining -= tokens;
      continue;
    }
    head.push(truncateUserMessage(message, headRemaining));
    break;
  }

  let keptTokens = 0;
  for (const message of head) keptTokens += estimateTokensForMessage(message);
  for (const message of tail) keptTokens += estimateTokensForMessage(message);
  return { head, tail, elided: true, omittedTokens: Math.max(0, totalTokens - keptTokens) };
}

/**
 * Model-facing text of the elision marker placed between the head and tail
 * segments. Wrapped in `<system-reminder>` so the model reads it as harness
 * guidance rather than user input.
 */
export function buildCompactionElisionText(omittedTokens: number): string {
  return [
    '<system-reminder>',
    `Some of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly ${String(omittedTokens)} tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation.`,
    '</system-reminder>',
  ].join('\n');
}

export function buildCompactionSummaryText(summary: string): string {
  const suffix = summary.trim();
  return `${COMPACTION_SUMMARY_PREFIX}\n${suffix.length > 0 ? suffix : '(no summary available)'}`;
}
