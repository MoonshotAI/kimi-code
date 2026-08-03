/**
 * `contextProjector` domain (L4) — projects stored context history into the wire
 * messages sent to the model, and surfaces every repair it had to apply.
 *
 * `AgentContextProjectorService` is the Agent-scope binding. The projection
 * itself stays a pure transform over the history; repairs that keep the
 * outgoing wire valid (a displaced result moved back to its call, a synthetic
 * result invented for a lost one, an orphan/duplicate dropped, leading
 * non-user messages dropped, consecutive assistants merged, blank text
 * dropped, wholly-vacuous messages — nothing sendable was recorded, e.g. an
 * assistant step that kept only an empty thinking part — dropped whole) are
 * reported through an optional sink and surfaced once here as a
 * single deduped warning plus a `context_projection_repaired` telemetry event,
 * so a silently-mangled history always leaves a trace.
 *
 * `projectMediaDegraded` / `projectMediaStripped` are the fallback
 * projections for the two deterministic provider rejections: media-degraded
 * (all but the most recent media replaced by text markers) resends after an
 * HTTP 413 body-size rejection; media-stripped captures every media identity
 * present when degraded media is still too large or an image format is
 * rejected, then replaces only that snapshot on later steps so a newly
 * generated recovery image remains visible. Both are read-side only — the
 * history keeps its media.
 */

import { createHash } from 'node:crypto';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import { ErrorCodes, Error2 } from '#/errors';
import type { ContentPart, Message } from '#/kosong/contract/message';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  IAgentContextProjectorService,
  type MediaStripSnapshot,
} from './contextProjector';

export class AgentContextProjectorService implements IAgentContextProjectorService {
  declare readonly _serviceBrand: undefined;

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

  captureMediaStripSnapshot(messages: readonly ContextMessage[]): MediaStripSnapshot {
    return captureMediaStripSnapshot(this.projectWithTrace(messages, project));
  }

  projectMediaStripped(
    messages: readonly ContextMessage[],
    snapshot?: MediaStripSnapshot,
  ): readonly Message[] {
    const projected = this.projectWithTrace(messages, project);
    return stripMediaPartsBySnapshot(
      projected,
      snapshot ?? captureMediaStripSnapshot(projected),
    );
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
    let vacuousDropped = 0;
    for (const anomaly of notable) {
      if (anomaly.kind === 'tool_result_reordered') reordered += 1;
      else if (anomaly.kind === 'tool_result_synthesized') synthesized += 1;
      else if (anomaly.kind === 'orphan_tool_result_dropped') droppedOrphan += 1;
      else if (anomaly.kind === 'duplicate_tool_call_dropped') duplicateCallsDropped += 1;
      else if (anomaly.kind === 'duplicate_tool_result_dropped') duplicateResultsDropped += 1;
      else if (anomaly.kind === 'leading_non_user_dropped') leadingDropped += 1;
      else if (anomaly.kind === 'consecutive_assistants_merged') assistantsMerged += 1;
      else if (anomaly.kind === 'vacuous_message_dropped') vacuousDropped += 1;
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
      vacuousDropped,
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
      vacuous_dropped: vacuousDropped,
    });
  }
}

type ProjectionAnomaly =
  | { readonly kind: 'tool_result_reordered'; readonly toolCallId: string }
  | { readonly kind: 'tool_result_synthesized'; readonly toolCallId: string; readonly trailing: boolean }
  | { readonly kind: 'orphan_tool_result_dropped'; readonly toolCallId: string }
  | { readonly kind: 'duplicate_tool_call_dropped'; readonly toolCallId: string }
  | { readonly kind: 'duplicate_tool_result_dropped'; readonly toolCallId: string }
  | { readonly kind: 'leading_non_user_dropped'; readonly role: string }
  | { readonly kind: 'consecutive_assistants_merged' }
  | { readonly kind: 'whitespace_text_dropped'; readonly role: string }
  | { readonly kind: 'vacuous_message_dropped'; readonly role: string };

type OnAnomaly = (anomaly: ProjectionAnomaly) => void;

export const MEDIA_DEGRADE_KEEP_RECENT = 2;

const MEDIA_DEGRADED_PLACEHOLDERS = {
  image_url:
    '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
  audio_url:
    '[audio omitted: dropped to fit the provider request size limit; re-read the file to hear it]',
  video_url:
    '[video omitted: dropped to fit the provider request size limit; re-read the file to view it]',
} as const;

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

interface MediaStripSnapshotData {
  readonly keys: ReadonlySet<string>;
}

type MediaContainerKeyCache = Partial<Record<DegradableMediaPart['type'], string>>;

const MEDIA_CONTAINER_KEY_CACHE = new WeakMap<MediaContainer, MediaContainerKeyCache>();

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
  let cache = MEDIA_CONTAINER_KEY_CACHE.get(container);
  const cached = cache?.[part.type];
  if (cached !== undefined) return cached;

  const key = createHash('sha256')
    .update(part.type)
    .update('\0')
    .update(container.id ?? '')
    .update('\0')
    .update(container.url)
    .digest('hex');
  if (cache === undefined) {
    cache = {};
    MEDIA_CONTAINER_KEY_CACHE.set(container, cache);
  }
  cache[part.type] = key;
  return key;
}

function mediaStripSnapshotKeys(snapshot: MediaStripSnapshot): ReadonlySet<string> {
  return (snapshot as unknown as MediaStripSnapshotData).keys;
}

export function captureMediaStripSnapshot(
  messages: readonly Message[],
): MediaStripSnapshot {
  const keys = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (isDegradableMediaPart(part)) keys.add(mediaStripKey(part));
    }
  }
  return Object.freeze({ keys }) as unknown as MediaStripSnapshot;
}

export function stripMediaPartsBySnapshot(
  messages: readonly Message[],
  snapshot: MediaStripSnapshot,
): readonly Message[] {
  const keys = mediaStripSnapshotKeys(snapshot);
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (!isDegradableMediaPart(part) || !keys.has(mediaStripKey(part))) return part;
      changed = true;
      messageChanged = true;
      return { type: 'text', text: MEDIA_STRIPPED_PLACEHOLDERS[part.type] };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : messages;
}

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
      } else if (kept.length > 0 || !message.content.every(isVacuousContentPart)) {
        out.push({ ...message, toolCalls: kept });
      } else if (message.content.length > 0) {
        onAnomaly?.({ kind: 'vacuous_message_dropped', role: message.role });
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

function project(history: readonly ContextMessage[], onAnomaly?: OnAnomaly): Message[] {
  const hasAssistant = history.some(
    (message) => message.partial !== true && message.role === 'assistant',
  );

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

  const markForeignBetween = (): void => {
    for (const slot of openSlots.values()) slot.foreignBetween = true;
  };

  const emit = (source: ContextMessage): void => {
    const content = projectedContent(source, onAnomaly);
    if (source.toolCalls.length === 0 && !hasDeclaredTools(source)) {
      if (content.length === 0) return;
      if (content.every(isVacuousContentPart)) {
        onAnomaly?.({ kind: 'vacuous_message_dropped', role: source.role });
        return;
      }
    }

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
  InstantiationType.Eager,
  'contextProjector',
);
