/**
 * `contextProjector` domain (L4) — projects stored context history into the wire
 * messages sent to the model, and surfaces every repair it had to apply.
 *
 * `AgentContextProjectorService` is the Agent-scope binding. The projection
 * itself stays a pure transform over the history; repairs that keep the
 * outgoing wire valid (a displaced result moved back to its call, a synthetic
 * result invented for a lost one, an orphan/duplicate dropped, leading
 * non-user messages dropped, consecutive assistants merged, blank text
 * dropped) are reported through an optional sink and surfaced once here as a
 * single deduped warning plus a `context_projection_repaired` telemetry event,
 * so a silently-mangled history always leaves a trace.
 *
 * `projectMediaDegraded` / `projectMediaStripped` are the fallback
 * projections for the two deterministic provider rejections: media-degraded
 * (all but the most recent media replaced by text markers) resends after an
 * HTTP 413 body-size rejection; media-stripped (every media part replaced)
 * resends after an image-format rejection, since that error never says WHICH
 * image is poison and only a full strip guarantees a clean request. Both are
 * read-side only — the history keeps its media.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { ErrorCodes, Error2 } from '#/errors';
import type { ContentPart, Message } from '#/app/llmProtocol/message';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentContextProjectorService } from './contextProjector';

export class AgentContextProjectorService implements IAgentContextProjectorService {
  declare readonly _serviceBrand: undefined;

  // Signature of the last notable repair set that was logged. Lets a defect that
  // recurs identically every send (e.g. a persistently lost result re-synthesized
  // each turn) log once, not per step; reset to null on a clean projection so a
  // later recurrence after a healthy stretch is surfaced again.
  private lastRepairSignature: string | null = null;

  constructor(
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  project(messages: readonly ContextMessage[]): readonly Message[] {
    return this.projectWithTrace(messages, project);
  }

  projectStrict(messages: readonly ContextMessage[]): readonly Message[] {
    return this.projectWithTrace(messages, projectStrict);
  }

  projectMediaDegraded(messages: readonly ContextMessage[]): readonly Message[] {
    return degradeOlderMediaParts(
      this.projectWithTrace(messages, project),
      MEDIA_DEGRADE_KEEP_RECENT,
    );
  }

  projectMediaStripped(messages: readonly ContextMessage[]): readonly Message[] {
    return degradeOlderMediaParts(this.projectWithTrace(messages, project), 0, MEDIA_STRIPPED_PLACEHOLDERS);
  }

  private projectWithTrace(
    messages: readonly ContextMessage[],
    fn: (history: readonly ContextMessage[], onAnomaly?: (anomaly: ProjectionAnomaly) => void) => Message[],
  ): readonly Message[] {
    const anomalies: ProjectionAnomaly[] = [];
    const result = fn(messages, (anomaly) => anomalies.push(anomaly));
    this.reportProjectionRepairs(anomalies);
    return result;
  }

  // Surface the projector's wire-repairs so a silently-mangled history leaves a
  // trace. Deduped by signature so a defect that recurs identically every send
  // (e.g. a persistently lost result re-synthesized each turn) surfaces once,
  // not per step. Trailing-tail synthesis is excluded — it is the expected
  // close of an in-flight call, not a defect.
  private reportProjectionRepairs(anomalies: readonly ProjectionAnomaly[]): void {
    const notable = anomalies.filter(
      (anomaly) => !(anomaly.kind === 'tool_result_synthesized' && anomaly.trailing),
    );
    if (notable.length === 0) {
      this.lastRepairSignature = null;
      return;
    }
    const signature = notable
      .map((anomaly) => ('toolCallId' in anomaly ? `${anomaly.kind}:${anomaly.toolCallId}` : anomaly.kind))
      .toSorted()
      .join('|');
    if (signature === this.lastRepairSignature) return;
    this.lastRepairSignature = signature;

    let reordered = 0;
    let synthesized = 0;
    let droppedOrphan = 0;
    let duplicateCallsDropped = 0;
    let duplicateResultsDropped = 0;
    let leadingDropped = 0;
    let assistantsMerged = 0;
    let whitespaceDropped = 0;
    for (const anomaly of notable) {
      if (anomaly.kind === 'tool_result_reordered') reordered += 1;
      else if (anomaly.kind === 'tool_result_synthesized') synthesized += 1;
      else if (anomaly.kind === 'orphan_tool_result_dropped') droppedOrphan += 1;
      else if (anomaly.kind === 'duplicate_tool_call_dropped') duplicateCallsDropped += 1;
      else if (anomaly.kind === 'duplicate_tool_result_dropped') duplicateResultsDropped += 1;
      else if (anomaly.kind === 'leading_non_user_dropped') leadingDropped += 1;
      else if (anomaly.kind === 'consecutive_assistants_merged') assistantsMerged += 1;
      else whitespaceDropped += 1;
    }
    const toolCallIds = [
      ...new Set(
        notable.flatMap((anomaly) => ('toolCallId' in anomaly ? [anomaly.toolCallId] : [])),
      ),
    ].slice(0, 5);
    this.log.warn('repaired the request to keep it wire-valid', {
      reordered,
      synthesized,
      droppedOrphan,
      duplicateCallsDropped,
      duplicateResultsDropped,
      leadingDropped,
      assistantsMerged,
      whitespaceDropped,
      toolCallIds,
    });
    this.telemetry.track2('context_projection_repaired', {
      reordered,
      synthesized,
      dropped_orphan: droppedOrphan,
      duplicate_calls_dropped: duplicateCallsDropped,
      duplicate_results_dropped: duplicateResultsDropped,
      leading_dropped: leadingDropped,
      assistants_merged: assistantsMerged,
      whitespace_dropped: whitespaceDropped,
    });
  }
}

/**
 * A repair the projector applied to make the history wire-valid. Each one means
 * the stored history was not directly sendable to a strict provider.
 */
type ProjectionAnomaly =
  /** A recorded result was not adjacent to its call and had to be moved up. */
  | { readonly kind: 'tool_result_reordered'; readonly toolCallId: string }
  /**
   * No result existed for a call, so a placeholder was synthesized. `trailing`
   * is true when it closed a still-open tail call (expected, not a defect),
   * false when it closed a mid-history orphan whose result was lost.
   */
  | { readonly kind: 'tool_result_synthesized'; readonly toolCallId: string; readonly trailing: boolean }
  /** A result with no matching call anywhere was dropped. */
  | { readonly kind: 'orphan_tool_result_dropped'; readonly toolCallId: string }
  /** A tool call whose id already appeared earlier was dropped (strict only). */
  | { readonly kind: 'duplicate_tool_call_dropped'; readonly toolCallId: string }
  /** A second result for an already-answered id was dropped (strict only). */
  | { readonly kind: 'duplicate_tool_result_dropped'; readonly toolCallId: string }
  /** A leading non-user message was dropped so the first turn is user (strict). */
  | { readonly kind: 'leading_non_user_dropped'; readonly role: string }
  /** Two adjacent assistant turns were merged into one (strict). */
  | { readonly kind: 'consecutive_assistants_merged' }
  /** A non-empty but all-whitespace text block was dropped. */
  | { readonly kind: 'whitespace_text_dropped'; readonly role: string };

type OnAnomaly = (anomaly: ProjectionAnomaly) => void;

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
 * Markers for the media-stripped resend after the provider rejected an
 * image's FORMAT (not its size): the image marker points the model at
 * re-reading the file, whose refusal carries per-OS conversion instructions;
 * audio/video are collateral of the full strip and say so.
 */
export const MEDIA_STRIPPED_PLACEHOLDERS = {
  image_url:
    '[image omitted: the provider rejected this image; re-read the file for conversion instructions]',
  audio_url:
    '[audio omitted: dropped along with a rejected image; re-read the file to hear it]',
  video_url:
    '[video omitted: dropped along with a rejected image; re-read the file to view it]',
} as const;

type MediaPlaceholderSet = typeof MEDIA_DEGRADED_PLACEHOLDERS | typeof MEDIA_STRIPPED_PLACEHOLDERS;

function isDegradableMediaPart(
  part: ContentPart,
): part is ContentPart & { type: keyof MediaPlaceholderSet } {
  return part.type in MEDIA_DEGRADED_PLACEHOLDERS;
}

/**
 * Replace all but the `keepRecent` most recent media parts with deterministic
 * text markers. This is the media-degraded projection used to resend a request
 * the provider rejected as too large (HTTP 413 on accumulated base64 media)
 * and — with `keepRecent = 0` and `MEDIA_STRIPPED_PLACEHOLDERS` — the resend
 * after an image-format rejection, where the poisoned image could be anywhere
 * and only a full strip guarantees a clean request. A purely read-side
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
): readonly Message[] {
  const mediaCount = messages.reduce(
    (count, message) => count + message.content.filter(isDegradableMediaPart).length,
    0,
  );
  let toDegrade = Math.max(0, mediaCount - keepRecent);
  if (toDegrade === 0) return messages;

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

function projectStrict(history: readonly ContextMessage[], onAnomaly?: OnAnomaly): Message[] {
  const projected = project(history, onAnomaly);
  return dropLeadingNonUserMessages(
    mergeConsecutiveAssistantMessages(dedupeDuplicateToolCalls(projected, onAnomaly), onAnomaly),
    onAnomaly,
  );
}

function dedupeDuplicateToolCalls(messages: readonly Message[], onAnomaly?: OnAnomaly): Message[] {
  const seenToolCallIds = new Set<string>();
  const keptToolResultIndexes = new Map<string, number>();
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
      } else if (kept.length > 0 || message.content.length > 0) {
        out.push({ ...message, toolCalls: kept });
      }
      continue;
    }
    if (message.role === 'tool' && message.toolCallId !== undefined) {
      const previousIndex = keptToolResultIndexes.get(message.toolCallId);
      if (previousIndex !== undefined) {
        if (isInterruptedToolResult(out[previousIndex]) && !isInterruptedToolResult(message)) {
          out[previousIndex] = message;
        } else {
          onAnomaly?.({ kind: 'duplicate_tool_result_dropped', toolCallId: message.toolCallId });
        }
        continue;
      }
      keptToolResultIndexes.set(message.toolCallId, out.length);
    }
    out.push(message);
  }
  return out;
}

function mergeConsecutiveAssistantMessages(
  messages: readonly Message[],
  onAnomaly?: OnAnomaly,
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

function dropLeadingNonUserMessages(messages: readonly Message[], onAnomaly?: OnAnomaly): Message[] {
  let start = 0;
  while (start < messages.length && messages[start]?.role !== 'user') {
    onAnomaly?.({ kind: 'leading_non_user_dropped', role: messages[start]!.role });
    start += 1;
  }
  return start === 0 ? [...messages] : messages.slice(start);
}

// Projects the stored context history into the wire messages sent to the
// model, in a single pass over the history.
//
// Strict providers require every tool call to be answered right after the
// assistant message, so each call is closed on the spot with a synthetic
// interrupted result and its slot in the output stays open until the recorded
// result overwrites it in place. A call stays open until its first result; a
// call id reused by a later assistant re-targets the slots that follow.
// Partial messages (stream interrupted) are invisible here, so their calls
// never anchor an exchange. Tool messages are skipped where they originally
// sat — a result either lands in its call's slot or it is an orphan,
// wire-invalid and useless to the model. A history with no assistant at all
// is a bare sizing slice and passes through as-is. Emitting cleans each message (drops empty /
// whitespace-only text blocks, rejected by strict providers), merges runs of
// adjacent user prompts (accumulated and materialized once per run), and
// strips context-only metadata off the wire.
//
// Every repair that changes what the model sees (a displaced result pulled up,
// a lost result synthesized, an orphan dropped, blank text dropped) is reported
// through `onAnomaly`; the projection stays a pure transform and the caller
// decides whether to surface the trace.
//
// The projected messages share their content parts and tool calls with the
// stored context (only the top-level wrapper is rebuilt); consumers must
// treat the projection as read-only, which every provider conversion already
// honors by building fresh structures.
function project(history: readonly ContextMessage[], onAnomaly?: OnAnomaly): Message[] {
  const hasAssistant = history.some(
    (message) => message.partial !== true && message.role === 'assistant',
  );

  // Last history index that is a real, non-tool turn. A call still open at the
  // end whose owning assistant sits at/after it closed a trailing, possibly
  // in-flight call (expected); one whose owner precedes it lost its result
  // mid-history (a defect). Mirrors the trailing/mid-history split used to keep
  // the trace free of routine in-flight closes.
  let lastNonToolIndex = history.length - 1;
  while (
    lastNonToolIndex >= 0 &&
    (history[lastNonToolIndex]?.role === 'tool' || history[lastNonToolIndex]?.partial === true)
  ) {
    lastNonToolIndex -= 1;
  }

  const out: Message[] = [];
  const openSlots = new Map<string, OpenSlot>();
  let merge: MergeGroup | undefined;

  const flushMerge = (): void => {
    if (merge === undefined) return;
    if (merge.singleContent === undefined) {
      const text = merge.texts.join('\n\n');
      const content: ContentPart[] = text === '' ? [] : [{ type: 'text', text }];
      content.push(...merge.parts);
      out[merge.index] = {
        role: 'user',
        name: undefined,
        content,
        toolCalls: [],
        toolCallId: undefined,
        partial: undefined,
      };
    }
    merge = undefined;
  };

  // A real (non-tool) message — or a result for an unknown call — landing while
  // calls are still open means those calls' results were not adjacent in the
  // stored history; pulling them up is a real repair worth tracing.
  const markForeignBetween = (): void => {
    for (const slot of openSlots.values()) slot.foreignBetween = true;
  };

  const emit = (source: ContextMessage): void => {
    const content = projectedContent(source, onAnomaly);
    if (content.length === 0 && source.toolCalls.length === 0 && !hasDeclaredTools(source)) return;

    if (openSlots.size > 0) markForeignBetween();

    if (canMergeUserMessage(source)) {
      if (merge === undefined) {
        out.push(toWireMessage(source, content));
        merge = { index: out.length - 1, singleContent: content, texts: [], parts: [] };
      } else {
        if (merge.singleContent !== undefined) {
          appendMergeContent(merge, merge.singleContent);
          merge.singleContent = undefined;
        }
        appendMergeContent(merge, content);
      }
      return;
    }
    flushMerge();
    out.push(toWireMessage(source, content));
  };

  for (const [index, message] of history.entries()) {
    if (message.partial === true) continue;
    if (message.role === 'tool') {
      if (!hasAssistant) {
        emit(message);
        continue;
      }
      if (message.toolCallId === undefined) continue;
      const slot = openSlots.get(message.toolCallId);
      if (slot === undefined) {
        if (openSlots.size > 0) markForeignBetween();
        onAnomaly?.({ kind: 'orphan_tool_result_dropped', toolCallId: message.toolCallId });
        continue;
      }
      openSlots.delete(message.toolCallId);
      if (slot.foreignBetween) {
        onAnomaly?.({ kind: 'tool_result_reordered', toolCallId: message.toolCallId });
      }
      out[slot.index] = toWireMessage(message, projectedContent(message, onAnomaly));
      continue;
    }
    emit(message);
    for (const call of message.toolCalls) {
      const reopened = openSlots.get(call.id);
      if (reopened !== undefined) {
        out[reopened.index] = createInterruptedToolResult(call.id);
        onAnomaly?.({
          kind: 'tool_result_synthesized',
          toolCallId: call.id,
          trailing: reopened.ownerIndex >= lastNonToolIndex,
        });
      }
      openSlots.set(call.id, { index: out.length, ownerIndex: index, foreignBetween: false });
      out.push(TOOL_RESULT_SLOT);
    }
  }
  for (const [id, slot] of openSlots) {
    out[slot.index] = createInterruptedToolResult(id);
    onAnomaly?.({
      kind: 'tool_result_synthesized',
      toolCallId: id,
      trailing: slot.ownerIndex >= lastNonToolIndex,
    });
  }
  flushMerge();
  return out;
}

interface OpenSlot {
  index: number;
  ownerIndex: number;
  foreignBetween: boolean;
}

interface MergeGroup {
  index: number;
  singleContent: readonly ContentPart[] | undefined;
  texts: string[];
  parts: ContentPart[];
}

// Join only the non-empty texts so merging an image-only message never
// produces a whitespace-only text block (rejected by strict providers).
function appendMergeContent(group: MergeGroup, content: readonly ContentPart[]): void {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
    else group.parts.push(part);
  }
  if (text.length > 0) group.texts.push(text);
}

function projectedContent(source: ContextMessage, onAnomaly?: OnAnomaly): ContentPart[] {
  const content =
    source.role === 'tool'
      ? renderToolResultForModel({
          output: outputFromToolContent(source.content),
          isError: source.isError,
          note: source.note,
        })
      : source.content;
  return cleanContent(source, content, onAnomaly);
}

function cleanContent(
  source: ContextMessage,
  rawContent: readonly ContentPart[],
  onAnomaly?: OnAnomaly,
): ContentPart[] {
  const hasBlank = rawContent.some(isBlankText);
  let content: readonly ContentPart[] = rawContent;
  if (hasBlank) {
    const filtered: ContentPart[] = [];
    for (const part of rawContent) {
      if (isBlankText(part)) {
        // Report only whitespace-only (non-empty) blocks: a truly empty `''`
        // block is routine cleanup, whereas a block that is non-empty yet
        // all-whitespace signals upstream fed blank content worth surfacing.
        if (part.type === 'text' && part.text.length > 0) {
          onAnomaly?.({ kind: 'whitespace_text_dropped', role: source.role });
        }
      } else {
        filtered.push(part);
      }
    }
    content = filtered;
  }
  if (source.role === 'tool' && content.length === 0) {
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      'Tool result message content cannot be empty after removing empty text blocks.',
      { details: { toolCallId: source.toolCallId } },
    );
  }
  return [...content];
}

function outputFromToolContent(content: readonly ContentPart[]): string | readonly ContentPart[] {
  const only = content[0];
  return content.length === 1 && only?.type === 'text' ? only.text : content;
}

const TOOL_INTERRUPTED_TEXT =
  'Tool result is not available in the current context. Do not assume the tool completed successfully.';

// Shared inert filler for a call's slot while it awaits its recorded result;
// every slot still open at the end is overwritten with a synthetic result, so
// this object never reaches the returned projection.
const TOOL_RESULT_SLOT: Message = createInterruptedToolResult('');

function createInterruptedToolResult(toolCallId: string): Message {
  return {
    role: 'tool',
    name: undefined,
    content: [{ type: 'text', text: TOOL_INTERRUPTED_TEXT }],
    toolCalls: [],
    toolCallId,
    partial: undefined,
  };
}

function isInterruptedToolResult(message: Message | undefined): boolean {
  if (message?.role !== 'tool') return false;
  const [part] = message.content;
  return part?.type === 'text' && part.text === TOOL_INTERRUPTED_TEXT;
}

function isBlankText(part: ContentPart): boolean {
  return part.type === 'text' && part.text.trim().length === 0;
}

function canMergeUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

function hasDeclaredTools(message: ContextMessage): boolean {
  return message.tools !== undefined && message.tools.length > 0;
}

function toWireMessage(message: ContextMessage, content: ContentPart[]): Message {
  return {
    role: message.role,
    name: message.name,
    content,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    partial: message.partial,
    tools: message.tools,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextProjectorService,
  AgentContextProjectorService,
  InstantiationType.Delayed,
  'contextProjector',
);
