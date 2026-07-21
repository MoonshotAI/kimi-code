import { createHash } from 'node:crypto';

import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';

import { ErrorCodes, KimiError } from '../../errors';
import { renderToolResultForModel } from './tool-result-render';
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
   * `tool_use` anywhere in the provided messages. Such an orphan is wire-invalid
   * on every strict provider and useless to the model (it has no record of the
   * call the result answers). Enabled on every request-building projection — the
   * normal wire, the strict resend, and the compaction summarizer — so a stray
   * result never reaches a provider. Left OFF for non-request projections (e.g.
   * token-estimating a history slice), where a result's matching call may
   * legitimately sit outside the slice and must not be mistaken for an orphan.
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
   * When `true`, drop assistant tool calls whose id already appeared earlier
   * (first occurrence wins; a message left with no calls and no sendable
   * content is dropped), and drop every tool result after the first for a
   * given id so the kept call keeps exactly one answer. Duplicate ids are
   * wire-invalid on
   * strict providers ("`tool_use` ids must be unique") and no other pass can
   * repair them. Strict-resend only: a provider that accepted the duplicates
   * when it produced them (e.g. per-response counter ids like `call_0`) must
   * keep seeing the history it generated — deduping the normal path would
   * silently erase its later tool exchanges.
   */
  readonly dedupeDuplicateToolCalls?: boolean;
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
  /** A result with no matching call anywhere was dropped (wire exits only). */
  | { readonly kind: 'orphan_tool_result_dropped'; readonly toolCallId: string }
  /** A tool call whose id already appeared earlier was dropped (strict-resend only). */
  | { readonly kind: 'duplicate_tool_call_dropped'; readonly toolCallId: string }
  /** A second result for an already-answered id was dropped (strict-resend only). */
  | { readonly kind: 'duplicate_tool_result_dropped'; readonly toolCallId: string }
  /** A leading non-user message was dropped so the first turn is user (strict). */
  | { readonly kind: 'leading_non_user_dropped'; readonly role: string }
  /** Two adjacent assistant turns were merged into one (strict). */
  | { readonly kind: 'consecutive_assistants_merged' }
  /** A non-empty but all-whitespace text block was dropped (always). */
  | { readonly kind: 'whitespace_text_dropped'; readonly role: string }
  /**
   * Every recorded part serialized to nothing on the wire (e.g. an assistant
   * step that recorded only an empty thinking part from a provider-filtered
   * response), so the whole message was dropped. Distinct from the silent
   * empty-content drop: parts were recorded, yet none of them was sendable —
   * a genuine defect signal, not routine cleanup.
   */
  | { readonly kind: 'vacuous_message_dropped'; readonly role: string };

export function project(history: readonly ContextMessage[], options?: ProjectOptions): Message[] {
  let result = mergeAdjacentUserMessages(history, options?.onAnomaly);
  if (options?.dedupeDuplicateToolCalls === true) {
    result = dedupeDuplicateToolCalls(result, options.onAnomaly);
  }
  result = repairToolExchangeAdjacency(result, options);
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

// Strict providers reject a request whose assistant messages carry two
// `tool_use` blocks with the same id ("tool_use ids must be unique"). Keep the
// first occurrence of each call id, drop the rest, and drop an assistant
// message entirely when duplicates were all it carried — or when removing
// them leaves only vacuous content (e.g. a single empty thinking block),
// which would serialize as an empty assistant and be rejected again on the
// strict retry ("the message ... with role 'assistant' must not be empty").
// Every result after the
// first for a given id is dropped with its call, so no dangling tool message
// survives the dedupe; when the kept call has no result of its own, the later
// duplicate's surviving result is reattached by the adjacency repair. Runs
// before the adjacency repair so pending-result matching never sees the
// duplicate. Strict-resend only (see `ProjectOptions.dedupeDuplicateToolCalls`):
// the normal projection keeps duplicates verbatim for the lax provider that
// produced and accepts them.
function dedupeDuplicateToolCalls(
  messages: readonly Message[],
  onAnomaly?: (anomaly: ProjectionAnomaly) => void,
): Message[] {
  const seenToolCallIds = new Set<string>();
  const seenToolResultIds = new Set<string>();
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      const kept = message.toolCalls.filter((toolCall) => {
        if (seenToolCallIds.has(toolCall.id)) {
          onAnomaly?.({ kind: 'duplicate_tool_call_dropped', toolCallId: toolCall.id });
          return false;
        }
        seenToolCallIds.add(toolCall.id);
        return true;
      });
      if (kept.length === message.toolCalls.length) {
        out.push(message);
      } else if (kept.length > 0 || !message.content.every(isVacuousContentPart)) {
        out.push({ ...message, toolCalls: kept });
      } else if (message.content.length > 0) {
        // Every call this message carried was a later duplicate, and only
        // vacuous content remains: kept, it would serialize as an empty
        // assistant and be rejected again on the strict retry. Drop it with
        // a trace (a truly content-free message stays a silent drop).
        onAnomaly?.({ kind: 'vacuous_message_dropped', role: message.role });
      }
      continue;
    }
    if (message.role === 'tool' && message.toolCallId !== undefined) {
      if (seenToolResultIds.has(message.toolCallId)) {
        onAnomaly?.({ kind: 'duplicate_tool_result_dropped', toolCallId: message.toolCallId });
        continue;
      }
      seenToolResultIds.add(message.toolCallId);
    }
    out.push(message);
  }
  return out;
}

// Remove any `tool_result` whose `toolCallId` matches no assistant `tool_use`
// anywhere in the projected messages. Strict providers reject such a stray
// result, and it is useless to the model regardless (it has no record of the
// call the result answers), so every request-building projection drops it (via
// `dropOrphanResults`). Kept separate from the adjacency repair, which only
// reorders results that DO have a matching call; this removes the ones that do
// not. Reported via `onAnomaly` so the drop leaves a trace instead of silently
// discarding a recorded result.
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

  // Tool results are stored as facts (raw output + structured isError/note).
  // Render the model-visible form — error status prefix, empty-output
  // placeholder, trailing note — exactly here, at the projection boundary.
  const source =
    message.role === 'tool'
      ? { ...message, content: renderToolResultForModel({ output: message.content, note: message.note, isError: message.isError }) }
      : message;

  let content: ContentPart[] | undefined;
  for (const [index, part] of source.content.entries()) {
    // Strict providers reject a text block that is empty OR whitespace-only
    // ("text content blocks must contain non-whitespace text"). Drop both; a
    // block with surrounding whitespace but real content is kept verbatim.
    if (part.type === 'text' && part.text.trim().length === 0) {
      content ??= source.content.slice(0, index);
      // Report only whitespace-only (non-empty) blocks: a truly empty `''` block
      // is routine cleanup (e.g. a trailing empty text part after a tool call),
      // whereas a block that is non-empty yet all-whitespace signals something
      // upstream fed blank content and is worth surfacing for debugging.
      if (part.text.length > 0) {
        onAnomaly?.({ kind: 'whitespace_text_dropped', role: source.role });
      }
      continue;
    }
    content?.push(part);
  }

  const next = content === undefined ? source : { ...source, content };
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
  // A message that loads tool definitions (`tools` present) is intentionally
  // content-free — it must survive the empty-message cleanup or the loaded
  // schemas silently vanish from every outgoing request.
  if (next.tools !== undefined && next.tools.length > 0) return next;
  if (next.toolCalls.length > 0) return next;
  if (next.content.length === 0) return null;
  // Every remaining part serializes to nothing on the wire — e.g. an
  // assistant step that recorded only an empty thinking part from a
  // provider-filtered response. Sent as-is it becomes an assistant message
  // with no content and no tool calls, which strict providers reject ("the
  // message ... with role 'assistant' must not be empty") on every resend,
  // permanently wedging the session. Drop the whole message here. A message
  // that carries any real content keeps every part verbatim — including
  // empty thinking blocks, which preserved-thinking providers require back.
  if (next.content.every(isVacuousContentPart)) {
    onAnomaly?.({ kind: 'vacuous_message_dropped', role: next.role });
    return null;
  }
  return next;
}

/**
 * True when a content part carries nothing the provider wire can represent:
 * an empty or whitespace-only text block, or an empty thinking block with no
 * provider signature. A signed thinking block (`encrypted`) is never vacuous
 * — reasoning providers require it back verbatim — and media parts always
 * carry content.
 */
function isVacuousContentPart(part: ContentPart): boolean {
  if (part.type === 'text') return part.text.trim().length === 0;
  if (part.type === 'think') return part.encrypted === undefined && part.think.trim().length === 0;
  return false;
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
    tools: message.tools?.map((tool) => ({ ...tool })),
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

/**
 * How many of the most recent media parts survive the media-degraded
 * projection. The tail images are what the model is actively working from
 * (the screenshot it just took); everything older is replaced by a marker.
 */
export const MEDIA_DEGRADE_KEEP_RECENT = 2;

const MEDIA_DEGRADED_PLACEHOLDERS = {
  image_url:
    '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
  audio_url:
    '[audio omitted: dropped to fit the provider request size limit; re-read the file to hear it]',
  video_url:
    '[video omitted: dropped to fit the provider request size limit; re-read the file to view it]',
} as const;

/**
 * Provider-compatible markers for a resend with every media part stripped.
 * This projection recovers from both an image-format rejection and a request
 * that remains too large after retaining recent media, so the wording must
 * not diagnose either cause. Re-reading the path gives the model the relevant
 * conversion or size-reduction guidance at the tool boundary.
 */
export const MEDIA_STRIPPED_PLACEHOLDERS = {
  image_url:
    '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]',
  audio_url:
    '[audio omitted for provider compatibility; re-read the file to hear it]',
  video_url:
    '[video omitted for provider compatibility; re-read the file to view it]',
} as const;

type MediaPlaceholderSet = typeof MEDIA_DEGRADED_PLACEHOLDERS | typeof MEDIA_STRIPPED_PLACEHOLDERS;

type DegradableMediaPart = Extract<
  ContentPart,
  { readonly type: keyof MediaPlaceholderSet }
>;

interface MediaContainer {
  readonly url: string;
  readonly id?: string;
}

/**
 * Content identities of the media present when full stripping first becomes
 * necessary in a turn. Digests, rather than part/container object identity,
 * survive compaction and ensure re-reading identical media remains stripped.
 */
export type MediaStripSnapshot = ReadonlySet<string>;

/**
 * Projection shallow-clones content parts but keeps their nested media
 * containers. Cache each container's digest so sticky stripped projections do
 * not rescan giant base64 data URLs on every step. A clone produced by
 * compaction misses the cache but recomputes the same content digest.
 */
const MEDIA_CONTAINER_KEY_CACHE = new WeakMap<
  MediaContainer,
  Partial<Record<DegradableMediaPart['type'], string>>
>();

function isDegradableMediaPart(
  part: ContentPart,
): part is DegradableMediaPart {
  return part.type in MEDIA_DEGRADED_PLACEHOLDERS;
}

function mediaContainer(part: DegradableMediaPart): MediaContainer {
  if (part.type === 'image_url') return part.imageUrl;
  if (part.type === 'audio_url') return part.audioUrl;
  return part.videoUrl;
}

function mediaStripKey(part: DegradableMediaPart): string {
  const container = mediaContainer(part);
  const keysByType = MEDIA_CONTAINER_KEY_CACHE.get(container);
  const cached = keysByType?.[part.type];
  if (cached !== undefined) return cached;

  const key = createHash('sha256')
    .update(part.type)
    .update('\0')
    .update(container.id ?? '')
    .update('\0')
    .update(container.url)
    .digest('hex');
  if (keysByType === undefined) {
    MEDIA_CONTAINER_KEY_CACHE.set(container, { [part.type]: key });
  } else {
    keysByType[part.type] = key;
  }
  return key;
}

/** Capture the provider-visible content identity of every current media part. */
export function captureMediaStripSnapshot(messages: readonly Message[]): MediaStripSnapshot {
  const snapshot = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (isDegradableMediaPart(part)) snapshot.add(mediaStripKey(part));
    }
  }
  return snapshot;
}

/**
 * Replace only media captured in `snapshot`. Media produced later with a new
 * provider-visible identity survives, allowing the model to read a smaller
 * recovery copy while the oversized/poisoned content stays stripped.
 */
export function stripMediaPartsBySnapshot(
  messages: readonly Message[],
  snapshot: MediaStripSnapshot,
): Message[] {
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (!isDegradableMediaPart(part) || !snapshot.has(mediaStripKey(part))) return part;
      changed = true;
      messageChanged = true;
      return { type: 'text', text: MEDIA_STRIPPED_PLACEHOLDERS[part.type] };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : (messages as Message[]);
}

/**
 * Replace all but the `keepRecent` most recent media parts with deterministic
 * text markers. This is the media-degraded projection used to resend a request
 * the provider rejected as too large (HTTP 413 on accumulated base64 media)
 * and — with `keepRecent = 0` and `MEDIA_STRIPPED_PLACEHOLDERS` — the resend
 * after a provider media rejection, where only a full strip guarantees a
 * compatible request. A purely read-side
 * transform — the underlying history is left untouched — that trades pixels
 * for deliverability while the surrounding text (including ReadMediaFile's
 * `<image path="...">` wrapper) survives, so the model can re-read any file
 * it still needs. Untouched messages are returned by reference, and when
 * nothing needs degrading the input array itself is returned.
 */
export function degradeOlderMediaParts(
  messages: readonly Message[],
  keepRecent: number,
  placeholders: MediaPlaceholderSet = MEDIA_DEGRADED_PLACEHOLDERS,
): Message[] {
  const mediaCount = messages.reduce(
    (count, message) => count + message.content.filter(isDegradableMediaPart).length,
    0,
  );
  let toDegrade = Math.max(0, mediaCount - keepRecent);
  if (toDegrade === 0) return messages as Message[];

  return messages.map((message) => {
    if (toDegrade === 0 || !message.content.some(isDegradableMediaPart)) return message;
    const content = message.content.map((part): ContentPart => {
      if (toDegrade === 0 || !isDegradableMediaPart(part)) return part;
      toDegrade -= 1;
      return { type: 'text', text: placeholders[part.type] };
    });
    return { ...message, content };
  });
}
