import { IInstantiationService } from "#/_base/di/instantiation";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { ErrorCodes, KimiError } from '#/errors';
import { IAgentMicroCompactionService } from '#/agent/microCompaction/microCompaction';
import type { ContentPart, Message } from '#/app/llmProtocol/message';
import { IAgentContextProjectorService } from './contextProjector';

export class AgentContextProjectorService implements IAgentContextProjectorService {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  project(messages: readonly ContextMessage[]): readonly Message[] {
    return project(this.microCompaction().compact(messages));
  }

  projectStrict(messages: readonly ContextMessage[]): readonly Message[] {
    return projectStrict(this.microCompaction().compact(messages));
  }

  private microCompaction(): IAgentMicroCompactionService {
    return this.instantiation.invokeFunction((accessor) =>
      accessor.get(IAgentMicroCompactionService),
    );
  }
}

function projectStrict(history: readonly ContextMessage[]): Message[] {
  const projected = project(history);
  return dropLeadingNonUserMessages(mergeConsecutiveAssistantMessages(dedupeDuplicateToolCalls(projected)));
}

function dedupeDuplicateToolCalls(messages: readonly Message[]): Message[] {
  const seenToolCallIds = new Set<string>();
  const keptToolResultIndexes = new Map<string, number>();
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls.length > 0) {
      const kept = message.toolCalls.filter((toolCall) => {
        if (seenToolCallIds.has(toolCall.id)) return false;
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
        }
        continue;
      }
      keptToolResultIndexes.set(message.toolCallId, out.length);
    }
    out.push(message);
  }
  return out;
}

function mergeConsecutiveAssistantMessages(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const previous = out.at(-1);
    if (previous !== undefined && previous.role === 'assistant' && message.role === 'assistant') {
      out[out.length - 1] = {
        ...previous,
        content: [...previous.content, ...message.content],
        toolCalls: [...previous.toolCalls, ...message.toolCalls],
      };
      continue;
    }
    out.push(message);
  }
  return out;
}

function dropLeadingNonUserMessages(messages: readonly Message[]): Message[] {
  let start = 0;
  while (start < messages.length && messages[start]?.role !== 'user') start += 1;
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
// is a bare sizing slice (micro-compaction sizes single messages this way)
// and passes through as-is. Emitting cleans each message (drops empty /
// whitespace-only text blocks, rejected by strict providers), merges runs of
// adjacent user prompts (accumulated and materialized once per run), and
// strips context-only metadata off the wire.
//
// The projected messages share their content parts and tool calls with the
// stored context (only the top-level wrapper is rebuilt); consumers must
// treat the projection as read-only, which every provider conversion already
// honors by building fresh structures.
function project(history: readonly ContextMessage[]): Message[] {
  const hasAssistant = history.some(
    (message) => message.partial !== true && message.role === 'assistant',
  );

  const out: Message[] = [];
  const openSlots = new Map<string, number>();
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

  const emit = (source: ContextMessage): void => {
    const content = projectedContent(source);
    if (content.length === 0 && source.toolCalls.length === 0) return;

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

  for (const message of history) {
    if (message.partial === true) continue;
    if (message.role === 'tool') {
      if (!hasAssistant) {
        emit(message);
        continue;
      }
      if (message.toolCallId === undefined) continue;
      const slot = openSlots.get(message.toolCallId);
      if (slot === undefined) continue;
      openSlots.delete(message.toolCallId);
      out[slot] = toWireMessage(message, projectedContent(message));
      continue;
    }
    emit(message);
    for (const call of message.toolCalls) {
      const reopened = openSlots.get(call.id);
      if (reopened !== undefined) out[reopened] = createInterruptedToolResult(call.id);
      openSlots.set(call.id, out.length);
      out.push(TOOL_RESULT_SLOT);
    }
  }
  for (const [id, slot] of openSlots) out[slot] = createInterruptedToolResult(id);
  flushMerge();
  return out;
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

function projectedContent(source: ContextMessage): ContentPart[] {
  const content =
    source.role === 'tool'
      ? renderToolResultForModel({
          output: outputFromToolContent(source.content),
          isError: source.isError,
          note: source.note,
        })
      : source.content;
  return cleanContent(source, content);
}

function cleanContent(source: ContextMessage, rawContent: readonly ContentPart[]): ContentPart[] {
  const content = rawContent.some(isBlankText)
    ? rawContent.filter((part) => !isBlankText(part))
    : rawContent;
  if (source.role === 'tool' && content.length === 0) {
    throw new KimiError(
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
  '<system>ERROR: Tool execution failed.</system>\n' +
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

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

function toWireMessage(message: ContextMessage, content: ContentPart[]): Message {
  return {
    role: message.role,
    name: message.name,
    content,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextProjectorService,
  AgentContextProjectorService,
  InstantiationType.Delayed,
  'contextProjector',
);
