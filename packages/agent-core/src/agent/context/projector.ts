import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';

import { ErrorCodes, KimiError } from '../../errors';
import type { ContextMessage } from './types';

export interface ProjectOptions {
  /**
   * When `true`, emit a synthetic `tool_result` for *every* assistant `tool_use`
   * whose result is not present in the provided messages — including a trailing,
   * still-in-flight call. Used by full compaction, where the compacted prefix is
   * a slice that may exclude a delayed result preserved in the retained tail; the
   * synthetic result keeps the exchange closed so the summary request is not
   * rejected. Leave `false` for normal turns: a *trailing* missing result there
   * means the call is still in-flight and must not be closed prematurely. (A
   * *non-trailing* missing result is always closed regardless of this flag — see
   * `repairToolExchangeAdjacency` — because a later turn proves it is not
   * in-flight.)
   */
  readonly synthesizeMissing?: boolean;
  /**
   * When `true`, drop any `tool_result` whose `toolCallId` matches no assistant
   * `tool_use` anywhere in the provided messages. Strict providers reject such a
   * stray result as an "unexpected `tool_result`". Off by default so the normal
   * path never silently discards recorded output; the post-400 strict-resend
   * fallback enables it (together with `synthesizeMissing`) as a last resort to
   * force a wire-compliant request out of an otherwise-bricked session.
   */
  readonly dropOrphanResults?: boolean;
  /**
   * When `true`, drop leading messages until the first one is a user turn. Strict
   * providers require the first message to be `user`; a history that (after
   * dropping/compaction) starts with an assistant or tool message is rejected.
   * Strict-resend only — the normal path keeps the original opening.
   */
  readonly dropLeadingNonUser?: boolean;
  /**
   * When `true`, merge back-to-back assistant messages into one. Strict providers
   * reject consecutive same-role turns ("roles must alternate"); consecutive user
   * turns are already merged at the provider boundary, but consecutive assistant
   * turns are not. Strict-resend only. Content is concatenated verbatim — callers
   * must not rely on this when extended-thinking ordering matters, but two
   * consecutive assistant turns do not arise in well-formed transcripts.
   */
  readonly mergeConsecutiveAssistants?: boolean;
  /**
   * Optional sink invoked for every repair the projector applies to keep the
   * outgoing wire valid: a displaced result moved back next to its call, a
   * synthetic result invented for a missing one, a stray result dropped, a
   * leading non-user message dropped, or consecutive assistants merged. The
   * projection itself stays a pure transform; the caller decides whether/how to
   * surface these (the context logs them so a silently-mangled history is never
   * papered over without a trace). Not called when the history is already
   * well-formed.
   */
  readonly onAnomaly?: (anomaly: ProjectionAnomaly) => void;
}

/**
 * A repair the projector applied to make the history wire-valid. Each one means
 * the stored history was not directly sendable to a strict provider.
 */
export type ProjectionAnomaly =
  /** A recorded result was not adjacent to its call and had to be moved up. */
  | { readonly kind: 'tool_result_reordered'; readonly toolCallId: string }
  /**
   * No result existed for a call, so a placeholder was synthesized. `trailing`
   * is true when it closed a still-open tail call (expected under
   * `synthesizeMissing`), false when it closed a mid-history orphan whose result
   * was lost (a genuine defect worth investigating).
   */
  | { readonly kind: 'tool_result_synthesized'; readonly toolCallId: string; readonly trailing: boolean }
  /** A result with no matching call anywhere was dropped (strict resend only). */
  | { readonly kind: 'orphan_tool_result_dropped'; readonly toolCallId: string }
  /** A leading non-user message was dropped so the first turn is user (strict). */
  | { readonly kind: 'leading_non_user_dropped'; readonly role: string }
  /** Two adjacent assistant turns were merged into one (strict). */
  | { readonly kind: 'consecutive_assistants_merged' }
  /** A non-empty but all-whitespace text block was dropped (always). */
  | { readonly kind: 'whitespace_text_dropped'; readonly role: string };

export function project(history: readonly ContextMessage[], options?: ProjectOptions): Message[] {
  let result = repairToolExchangeAdjacency(
    mergeAdjacentUserMessages(history, options?.onAnomaly),
    options,
  );
  if (options?.mergeConsecutiveAssistants === true) {
    result = mergeConsecutiveAssistantMessages(result, options.onAnomaly);
  }
  if (options?.dropOrphanResults === true) {
    result = dropOrphanToolResults(result, options.onAnomaly);
  }
  if (options?.dropLeadingNonUser === true) {
    result = dropLeadingNonUserMessages(result, options.onAnomaly);
  }
  return result;
}

// Strict providers (Anthropic) require every assistant `tool_use` to be answered
// by a matching `tool_result` in the immediately following message(s). A
// misordered history — where a `tool_result` is not adjacent to its `tool_use`,
// e.g. because a user message (background-task notification, flushed steer)
// landed in between, or because an interrupted / nested step delayed the result
// — is rejected with HTTP 400 ("`tool_use` without `tool_result` immediately
// after"). Micro compaction only exposed this latent misordering by busting the
// prompt cache and forcing a full revalidation.
//
// Repair the adjacency so every assistant `tool_use` is immediately followed by
// its matching `tool_result` message(s). Matching results are moved up from
// wherever they appear later in the history; any intervening messages keep their
// relative order and simply follow the repaired exchange.
//
// A tool call with no recorded result anywhere is closed with a synthetic
// `tool_result` UNLESS it belongs to the trailing exchange (no later
// user/assistant message follows it). A non-trailing missing result can never be
// in-flight — a subsequent turn proves the model already moved on — so leaving it
// open would strand the whole session behind a 400 on every send; it is closed
// here instead. The trailing exchange is left untouched by default: there a
// missing result genuinely means the call is still pending, and the
// trailing-open-exchange trim plus replay's interrupted-result synthesis own that
// case. With `synthesizeMissing`, even the trailing call is closed; full
// compaction uses this to keep a sliced prefix closed when a delayed result lives
// in the retained tail. This is purely a projection-time fix: the underlying
// history is left untouched, so replay and transcripts keep their original order,
// while the model always sees a well-formed tool exchange.
const SYNTHETIC_TOOL_RESULT_TEXT =
  'Tool result is not available in the current context. Do not assume the tool completed successfully.';

function repairToolExchangeAdjacency(
  messages: readonly Message[],
  options?: ProjectOptions,
): Message[] {
  // The trailing exchange is the only one whose missing result may still be
  // in-flight: any assistant `tool_use` that precedes a later user/assistant
  // message has been overtaken by a new turn and cannot be pending. Find the last
  // non-tool message so an orphan can be classified as trailing (index >= it) or
  // mid-history (index < it).
  let lastNonToolIndex = messages.length - 1;
  while (lastNonToolIndex >= 0 && messages[lastNonToolIndex]?.role === 'tool') {
    lastNonToolIndex -= 1;
  }

  const out: Message[] = [];
  const consumed = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (consumed.has(i)) continue;
    const message = messages[i]!;
    if (message.role !== 'assistant' || message.toolCalls.length === 0) {
      out.push(message);
      continue;
    }

    out.push(message);
    const pending = new Set(message.toolCalls.map((toolCall) => toolCall.id));
    // Tracks whether a foreign message (anything that is not one of this
    // exchange's own results) sits between the call and a later matching result;
    // if so, that result was displaced and pulling it up is a real repair.
    let foreignBetween = false;
    for (let j = i + 1; j < messages.length && pending.size > 0; j++) {
      if (consumed.has(j)) continue;
      const next = messages[j]!;
      const toolCallId = next.toolCallId;
      if (next.role === 'tool' && toolCallId !== undefined && pending.has(toolCallId)) {
        out.push(next);
        consumed.add(j);
        pending.delete(toolCallId);
        if (foreignBetween) options?.onAnomaly?.({ kind: 'tool_result_reordered', toolCallId });
      } else {
        foreignBetween = true;
      }
    }
    // Close any tool call whose result is absent. A mid-history orphan (a later
    // user/assistant message follows) is always closed — it cannot be in-flight.
    // The trailing exchange is closed only when `synthesizeMissing` is set, so a
    // genuinely pending call is left for the trim / replay synthesis otherwise.
    const isMidHistory = i < lastNonToolIndex;
    if (options?.synthesizeMissing === true || isMidHistory) {
      for (const missingId of pending) {
        out.push(makeSyntheticToolResult(missingId));
        options?.onAnomaly?.({
          kind: 'tool_result_synthesized',
          toolCallId: missingId,
          trailing: !isMidHistory,
        });
      }
    }
  }
  return out;
}

// Remove any `tool_result` whose `toolCallId` matches no assistant `tool_use`
// anywhere in the projected messages. Strict providers reject such a stray
// result; the post-400 strict-resend fallback drops them as a last resort. Kept
// separate from the adjacency repair so the normal path never discards output.
function dropOrphanToolResults(
  messages: readonly Message[],
  onAnomaly?: (anomaly: ProjectionAnomaly) => void,
): Message[] {
  const toolUseIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls) toolUseIds.add(toolCall.id);
    }
  }
  return messages.filter((message) => {
    if (message.role !== 'tool' || message.toolCallId === undefined) return true;
    if (toolUseIds.has(message.toolCallId)) return true;
    onAnomaly?.({ kind: 'orphan_tool_result_dropped', toolCallId: message.toolCallId });
    return false;
  });
}

// Merge back-to-back assistant messages into one. Strict providers reject
// consecutive same-role turns; the provider boundary already merges consecutive
// user turns, but not assistant turns. Strict-resend only. Content is
// concatenated verbatim (no reordering), so this is safe for the well-formed
// transcripts where it never fires, and a best-effort last resort otherwise.
function mergeConsecutiveAssistantMessages(
  messages: readonly Message[],
  onAnomaly?: (anomaly: ProjectionAnomaly) => void,
): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const previous = out.at(-1);
    if (previous !== undefined && previous.role === 'assistant' && message.role === 'assistant') {
      out[out.length - 1] = {
        ...previous,
        content: [...previous.content, ...message.content],
        toolCalls: [...previous.toolCalls, ...message.toolCalls],
      };
      onAnomaly?.({ kind: 'consecutive_assistants_merged' });
      continue;
    }
    out.push(message);
  }
  return out;
}

// Drop leading messages until the first one is a user turn. Strict providers
// require the first message to be `user`; a history that starts with an
// assistant or tool message (after dropping/compaction edge cases) is rejected.
// Strict-resend only.
function dropLeadingNonUserMessages(
  messages: readonly Message[],
  onAnomaly?: (anomaly: ProjectionAnomaly) => void,
): Message[] {
  let start = 0;
  while (start < messages.length && messages[start]!.role !== 'user') {
    onAnomaly?.({ kind: 'leading_non_user_dropped', role: messages[start]!.role });
    start += 1;
  }
  return start === 0 ? [...messages] : messages.slice(start);
}

function makeSyntheticToolResult(toolCallId: string): Message {
  return {
    role: 'tool',
    content: [{ type: 'text', text: SYNTHETIC_TOOL_RESULT_TEXT }],
    toolCalls: [],
    toolCallId,
  };
}

function mergeAdjacentUserMessages(
  history: readonly ContextMessage[],
  onAnomaly?: (anomaly: ProjectionAnomaly) => void,
): Message[] {
  const out: ContextMessage[] = [];
  for (const source of history) {
    const message = prepareMessageForProjection(source, onAnomaly);
    if (message === null) continue;

    const previous = out.at(-1);
    if (
      canMergeUserMessage(message) &&
      previous !== undefined &&
      canMergeUserMessage(previous)
    ) {
      out[out.length - 1] = mergeTwoUserMessages(previous, message);
      continue;
    }
    out.push(message);
  }
  return out.map(stripContextMetadata);
}

function prepareMessageForProjection(
  message: ContextMessage,
  onAnomaly?: (anomaly: ProjectionAnomaly) => void,
): ContextMessage | null {
  if (message.partial === true) return null;

  let content: ContentPart[] | undefined;
  for (const [index, part] of message.content.entries()) {
    // Strict providers reject a text block that is empty OR whitespace-only
    // ("text content blocks must contain non-whitespace text"). Drop both; a
    // block with surrounding whitespace but real content is kept verbatim.
    if (part.type === 'text' && part.text.trim().length === 0) {
      content ??= message.content.slice(0, index);
      // Report only whitespace-only (non-empty) blocks: a truly empty `''` block
      // is routine cleanup (e.g. a trailing empty text part after a tool call),
      // whereas a block that is non-empty yet all-whitespace signals something
      // upstream fed blank content and is worth surfacing for debugging.
      if (part.text.length > 0) {
        onAnomaly?.({ kind: 'whitespace_text_dropped', role: message.role });
      }
      continue;
    }
    content?.push(part);
  }

  const next = content === undefined ? message : { ...message, content };
  if (next.role === 'tool' && next.content.length === 0) {
    throw new KimiError(
      ErrorCodes.REQUEST_INVALID,
      'Tool result message content cannot be empty after removing empty text blocks.',
      {
        details: {
          toolCallId: next.toolCallId,
        },
      },
    );
  }
  return next.content.length === 0 && next.toolCalls.length === 0 ? null : next;
}

function canMergeUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

function mergeTwoUserMessages(a: ContextMessage, b: ContextMessage): ContextMessage {
  const aText = extractTextOnly(a);
  const bText = extractTextOnly(b);
  const nonTextParts = [
    ...a.content.filter((p) => p.type !== 'text'),
    ...b.content.filter((p) => p.type !== 'text'),
  ];
  const mergedText: TextPart = { type: 'text', text: `${aText}\n\n${bText}` };
  const content: ContentPart[] = [mergedText, ...nonTextParts];
  return {
    role: 'user',
    content,
    toolCalls: [],
    origin: a.origin,
  };
}

function extractTextOnly(message: Message): string {
  return message.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function stripContextMetadata(message: ContextMessage): Message {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map((p) => ({ ...p })) as ContentPart[],
    toolCalls: message.toolCalls.map((tc) => ({ ...tc })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}

export function trimTrailingOpenToolExchange(history: readonly Message[]): Message[] {
  let lastNonToolIndex = history.length - 1;
  while (lastNonToolIndex >= 0 && history[lastNonToolIndex]?.role === 'tool') {
    lastNonToolIndex -= 1;
  }

  const assistant = history[lastNonToolIndex];
  if (assistant === undefined) return [];
  if (assistant.role !== 'assistant' || assistant.toolCalls.length === 0) return [...history];

  const trailingToolCallIds = new Set(
    history
      .slice(lastNonToolIndex + 1)
      .map((message) => message.toolCallId)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
  );
  const closed = assistant.toolCalls.every((toolCall) => trailingToolCallIds.has(toolCall.id));
  return closed ? [...history] : history.slice(0, lastNonToolIndex);
}
