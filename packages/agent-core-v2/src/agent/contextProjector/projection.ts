/**
 * `contextProjector` domain — rebuilds stored context history into
 * provider-valid wire messages and reports every repair through an anomaly
 * sink.
 *
 * The default projection pairs tool calls with their results (a displaced
 * result returns to its call, an orphan is dropped, a call left open is
 * closed with a synthetic interrupted result), renders stored tool-result
 * facts for the model, drops blank text and wholly-vacuous messages, skips
 * partial messages, and merges consecutive user prompts. The strict
 * projection adds the repairs strict providers need: duplicate tool calls
 * dropped, consecutive assistants merged, leading non-user messages dropped.
 *
 * A history slice without any assistant message is a sizing slice (used to
 * size tool results): tool messages project like any other message instead
 * of pairing into exchanges. A synthesized close counts as `trailing` — an
 * expected in-flight close rather than a defect — exactly when no non-tool,
 * non-partial message follows the owning message in the slice.
 */

import { ErrorCodes, Error2 } from '#/errors';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import type { ContentPart, Message } from '#/kosong/contract/message';

export type ProjectionAnomaly =
  | { readonly kind: 'tool_result_reordered'; readonly toolCallId: string }
  | { readonly kind: 'tool_result_synthesized'; readonly toolCallId: string; readonly trailing: boolean }
  | { readonly kind: 'orphan_tool_result_dropped'; readonly toolCallId: string }
  | { readonly kind: 'duplicate_tool_call_dropped'; readonly toolCallId: string }
  | { readonly kind: 'duplicate_tool_result_dropped'; readonly toolCallId: string }
  | { readonly kind: 'leading_non_user_dropped'; readonly role: string }
  | { readonly kind: 'consecutive_assistants_merged' }
  | { readonly kind: 'whitespace_text_dropped'; readonly role: string }
  | { readonly kind: 'vacuous_message_dropped'; readonly role: string };

export type OnAnomaly = (anomaly: ProjectionAnomaly) => void;

export interface ProjectionRepairSummary {
  readonly reordered: number;
  readonly synthesized: number;
  readonly droppedOrphan: number;
  readonly duplicateCallsDropped: number;
  readonly duplicateResultsDropped: number;
  readonly leadingDropped: number;
  readonly assistantsMerged: number;
  readonly whitespaceDropped: number;
  readonly vacuousDropped: number;
}

export function summarizeProjectionRepairs(
  anomalies: readonly ProjectionAnomaly[],
): ProjectionRepairSummary {
  const summary = {
    reordered: 0,
    synthesized: 0,
    droppedOrphan: 0,
    duplicateCallsDropped: 0,
    duplicateResultsDropped: 0,
    leadingDropped: 0,
    assistantsMerged: 0,
    whitespaceDropped: 0,
    vacuousDropped: 0,
  };
  for (const anomaly of anomalies) {
    if (anomaly.kind === 'tool_result_reordered') summary.reordered += 1;
    else if (anomaly.kind === 'tool_result_synthesized') summary.synthesized += 1;
    else if (anomaly.kind === 'orphan_tool_result_dropped') summary.droppedOrphan += 1;
    else if (anomaly.kind === 'duplicate_tool_call_dropped') summary.duplicateCallsDropped += 1;
    else if (anomaly.kind === 'duplicate_tool_result_dropped') summary.duplicateResultsDropped += 1;
    else if (anomaly.kind === 'leading_non_user_dropped') summary.leadingDropped += 1;
    else if (anomaly.kind === 'consecutive_assistants_merged') summary.assistantsMerged += 1;
    else if (anomaly.kind === 'vacuous_message_dropped') summary.vacuousDropped += 1;
    else summary.whitespaceDropped += 1;
  }
  return summary;
}

export function project(history: readonly ContextMessage[], onAnomaly?: OnAnomaly): Message[] {
  const layout = sliceLayout(history);
  return flattenBlocks(pairBlocks(history, layout, onAnomaly), layout, onAnomaly);
}

export function projectStrict(
  history: readonly ContextMessage[],
  onAnomaly?: OnAnomaly,
): Message[] {
  const projected = project(history, onAnomaly);
  return dropLeadingNonUserMessages(
    mergeConsecutiveAssistantMessages(dedupeDuplicateToolCalls(projected, onAnomaly), onAnomaly),
    onAnomaly,
  );
}

interface SliceLayout {
  readonly sizing: boolean;
  readonly lastNonToolIndex: number;
}

function sliceLayout(history: readonly ContextMessage[]): SliceLayout {
  let sizing = true;
  let lastNonToolIndex = -1;
  for (const [index, message] of history.entries()) {
    if (message.partial === true || message.role === 'tool') continue;
    lastNonToolIndex = index;
    if (message.role === 'assistant') sizing = false;
  }
  return { sizing, lastNonToolIndex };
}

interface AttachedResult {
  readonly source: ContextMessage;
  readonly content: ContentPart[];
}

const INTERRUPTED_RESULT = Symbol('interruptedResult');

interface PendingCall {
  readonly callId: string;
  result: AttachedResult | typeof INTERRUPTED_RESULT | undefined;
  foreignBetween: boolean;
}

interface Exchange {
  readonly source: ContextMessage;
  readonly content: ContentPart[];
  readonly ownerIndex: number;
  readonly pending: PendingCall[];
}

type Block =
  | {
      readonly kind: 'message';
      readonly source: ContextMessage;
      readonly content: ContentPart[];
    }
  | { readonly kind: 'exchange'; readonly exchange: Exchange };

function pairBlocks(
  history: readonly ContextMessage[],
  layout: SliceLayout,
  onAnomaly?: OnAnomaly,
): Block[] {
  const blocks: Block[] = [];
  const openCalls = new Map<string, { exchange: Exchange; pending: PendingCall }>();

  const markForeignBetween = (): void => {
    for (const { pending } of openCalls.values()) pending.foreignBetween = true;
  };

  for (const [index, message] of history.entries()) {
    if (message.partial === true) continue;
    if (message.role === 'tool' && !layout.sizing) {
      if (message.toolCallId === undefined) continue;
      const open = openCalls.get(message.toolCallId);
      if (open === undefined) {
        markForeignBetween();
        onAnomaly?.({ kind: 'orphan_tool_result_dropped', toolCallId: message.toolCallId });
        continue;
      }
      openCalls.delete(message.toolCallId);
      open.pending.result = { source: message, content: projectedContent(message, onAnomaly) };
      if (open.pending.foreignBetween) {
        onAnomaly?.({ kind: 'tool_result_reordered', toolCallId: message.toolCallId });
      }
      continue;
    }

    const content = projectedContent(message, onAnomaly);
    if (message.toolCalls.length === 0 && !hasDeclaredTools(message)) {
      if (content.length === 0) continue;
      if (content.every(isVacuousContentPart)) {
        onAnomaly?.({ kind: 'vacuous_message_dropped', role: message.role });
        continue;
      }
    }
    markForeignBetween();
    if (message.toolCalls.length === 0) {
      blocks.push({ kind: 'message', source: message, content });
      continue;
    }

    const exchange: Exchange = { source: message, content, ownerIndex: index, pending: [] };
    blocks.push({ kind: 'exchange', exchange });
    for (const call of message.toolCalls) {
      const superseded = openCalls.get(call.id);
      if (superseded !== undefined) {
        superseded.pending.result = INTERRUPTED_RESULT;
        onAnomaly?.({
          kind: 'tool_result_synthesized',
          toolCallId: call.id,
          trailing: superseded.exchange.ownerIndex >= layout.lastNonToolIndex,
        });
      }
      const pending: PendingCall = { callId: call.id, result: undefined, foreignBetween: false };
      exchange.pending.push(pending);
      openCalls.set(call.id, { exchange, pending });
    }
  }
  return blocks;
}

interface MergeState {
  single: { readonly source: ContextMessage; readonly content: ContentPart[] } | undefined;
  readonly texts: string[];
  readonly parts: ContentPart[];
}

function flattenBlocks(
  blocks: readonly Block[],
  layout: SliceLayout,
  onAnomaly?: OnAnomaly,
): Message[] {
  const out: Message[] = [];
  let merge: MergeState | undefined;

  const flushMerge = (): void => {
    if (merge === undefined) return;
    if (merge.single !== undefined) {
      out.push(toWireMessage(merge.single.source, merge.single.content));
    } else {
      const text = merge.texts.join('\n\n');
      const content: ContentPart[] = text === '' ? [] : [{ type: 'text', text }];
      content.push(...merge.parts);
      out.push({
        role: 'user',
        name: undefined,
        content,
        toolCalls: [],
        toolCallId: undefined,
        partial: undefined,
      });
    }
    merge = undefined;
  };

  for (const block of blocks) {
    if (block.kind === 'message') {
      if (canMergeUserMessage(block.source)) {
        if (merge === undefined) {
          merge = { single: block, texts: [], parts: [] };
        } else {
          if (merge.single !== undefined) {
            appendMergeContent(merge, merge.single.content);
            merge.single = undefined;
          }
          appendMergeContent(merge, block.content);
        }
        continue;
      }
      flushMerge();
      out.push(toWireMessage(block.source, block.content));
      continue;
    }

    flushMerge();
    const { exchange } = block;
    out.push(toWireMessage(exchange.source, exchange.content));
    for (const pending of exchange.pending) {
      if (pending.result === undefined) {
        out.push(createInterruptedToolResult(pending.callId));
        onAnomaly?.({
          kind: 'tool_result_synthesized',
          toolCallId: pending.callId,
          trailing: exchange.ownerIndex >= layout.lastNonToolIndex,
        });
      } else if (pending.result === INTERRUPTED_RESULT) {
        out.push(createInterruptedToolResult(pending.callId));
      } else {
        out.push(toWireMessage(pending.result.source, pending.result.content));
      }
    }
  }
  flushMerge();
  return out;
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

function appendMergeContent(group: MergeState, content: readonly ContentPart[]): void {
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
