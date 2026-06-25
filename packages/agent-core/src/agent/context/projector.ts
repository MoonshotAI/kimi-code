import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';

import { ErrorCodes, KimiError } from '../../errors';
import type { ContextMessage } from './types';

export function project(history: readonly ContextMessage[]): Message[] {
  const usable = history
    .map(prepareMessageForProjection)
    .filter((message): message is ContextMessage => message !== null);
  return mergeAdjacentUserMessages(deferMessagesAroundOpenToolExchanges(usable));
}

const TOOL_INTERRUPTED_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_INTERRUPTED_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

/**
 * Normalizes a raw history into a sequence the model can consume: every
 * assistant tool call is immediately followed by its results (real results are
 * pulled up right after the call; messages that landed between a call and its
 * results — e.g. injected reminders — are moved to after the exchange closes),
 * and any tool call left unanswered is closed with a synthetic error result.
 *
 * This is the single place tool exchanges are made valid. `ContextMemory`
 * stores the raw insertion order and never closes anything; closure is
 * recomputed here on every projection, so it does not need to be persisted.
 */
export function deferMessagesAroundOpenToolExchanges(
  history: readonly ContextMessage[],
): ContextMessage[] {
  const out: ContextMessage[] = [];
  const pendingToolResultIds = new Set<string>();
  // Calls that have already been answered (by a real or synthetic result). A
  // second result for the same call is a stale duplicate and is dropped. A
  // result whose call has not been seen at all is kept — it may be a valid
  // result whose call sits outside a projected slice (micro-compaction projects
  // single messages to size them).
  const answeredToolCallIds = new Set<string>();
  let deferredMessages: ContextMessage[] = [];
  // Whether an assistant message has been emitted yet. A tool result whose call
  // was never seen is an orphan and is dropped — but only once we are in a real
  // projection context (an assistant has appeared). A leading tool result with
  // no assistant is a bare slice (micro-compaction sizes single messages this
  // way) and is kept.
  let sawAssistant = false;

  const push = (message: ContextMessage): void => {
    out.push(message);
    if (message.role !== 'assistant') return;
    sawAssistant = true;
    for (const toolCall of message.toolCalls) {
      pendingToolResultIds.add(toolCall.id);
      // A fresh call re-opens the id, so a later result is matched to this call
      // rather than being dropped as a duplicate of an earlier (reused) id.
      answeredToolCallIds.delete(toolCall.id);
    }
  };

  const acceptResult = (message: ContextMessage): void => {
    out.push(message);
    if (message.toolCallId !== undefined) answeredToolCallIds.add(message.toolCallId);
  };

  const flushDeferredMessages = (): void => {
    if (deferredMessages.length === 0) return;
    const messages = deferredMessages;
    deferredMessages = [];
    for (const message of messages) {
      visit(message);
    }
  };

  // Synthesize a result for every tool call still unanswered, then release the
  // messages that were waiting behind the (now closed) exchange.
  const closeOpenExchange = (): void => {
    for (const toolCallId of pendingToolResultIds) {
      out.push(createInterruptedToolResult(toolCallId));
      answeredToolCallIds.add(toolCallId);
    }
    pendingToolResultIds.clear();
    flushDeferredMessages();
  };

  const visit = (message: ContextMessage): void => {
    const isToolResult = message.role === 'tool' && message.toolCallId !== undefined;
    // A second result for an already-answered call is a stale duplicate.
    if (isToolResult && answeredToolCallIds.has(message.toolCallId!)) return;

    if (pendingToolResultIds.size === 0) {
      if (isToolResult) {
        // A result whose call was never seen is an orphan in a real projection,
        // but a kept message in a bare slice (no assistant yet).
        if (sawAssistant) return;
        acceptResult(message);
      } else {
        push(message);
      }
      return;
    }

    // A real result for one of the open calls — pull it up right after the call.
    if (isToolResult && pendingToolResultIds.has(message.toolCallId!)) {
      pendingToolResultIds.delete(message.toolCallId!);
      acceptResult(message);
      if (pendingToolResultIds.size === 0) flushDeferredMessages();
      return;
    }

    // A new assistant turn means the open calls will never be answered — close
    // them (synthetic results) before the new exchange starts.
    if (message.role === 'assistant') {
      closeOpenExchange();
      visit(message);
      return;
    }

    // Everything else (a stray reminder, a result for an as-yet-unseen call)
    // waits behind the open exchange and is released once it closes.
    deferredMessages.push(message);
  };

  for (const message of history) {
    visit(message);
  }
  // Close any exchange still open at the end of history.
  closeOpenExchange();

  return out;
}

function createInterruptedToolResult(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [
      { type: 'text', text: `${TOOL_INTERRUPTED_STATUS}\n${TOOL_INTERRUPTED_OUTPUT}` },
    ],
    toolCalls: [],
    toolCallId,
    isError: true,
  };
}

function mergeAdjacentUserMessages(history: readonly ContextMessage[]): Message[] {
  const out: ContextMessage[] = [];
  for (const source of history) {
    const message = prepareMessageForProjection(source);
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

function prepareMessageForProjection(message: ContextMessage): ContextMessage | null {
  if (message.partial === true) return null;

  let content: ContentPart[] | undefined;
  for (const [index, part] of message.content.entries()) {
    if (part.type === 'text' && part.text.length === 0) {
      content ??= message.content.slice(0, index);
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
      .filter((message) => !isInterruptedToolResult(message))
      .map((message) => message.toolCallId)
      .filter((toolCallId): toolCallId is string => typeof toolCallId === 'string'),
  );
  const closed = assistant.toolCalls.every((toolCall) => trailingToolCallIds.has(toolCall.id));
  return closed ? [...history] : history.slice(0, lastNonToolIndex);
}

function isInterruptedToolResult(message: Message): boolean {
  const content = message.content[0];
  return (
    message.role === 'tool' &&
    message.content.length === 1 &&
    content?.type === 'text' &&
    content.text === `${TOOL_INTERRUPTED_STATUS}\n${TOOL_INTERRUPTED_OUTPUT}`
  );
}
