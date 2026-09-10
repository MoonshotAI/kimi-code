import type { ContentPart, ToolCall } from '#/llm/message';
import type { TokenUsage } from '#/llm/usage';
import { readTodoItems, type TodoItem } from '#/todo/todoItem';

import { V2WireError, type V2WireRecord } from './wire';

const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
const COMPACT_USER_MESSAGE_HEAD_TOKENS = 2_000;
const MEDIA_TOKEN_ESTIMATE = 2000;

export interface V2PromptOrigin {
  kind: string;
  trigger?: string;
  variant?: string;
  ownerPromptId?: string;
  [key: string]: unknown;
}

export interface V2ContextMessage {
  role: string;
  content: ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  partial?: boolean;
  id?: string;
  providerMessageId?: string;
  origin?: V2PromptOrigin;
  isError?: boolean;
  note?: string;
}

export interface V2AssistantExtra {
  usage?: TokenUsage;
  finishReason?: string;
  rawFinishReason?: string;
  providerFinishReason?: string;
  model?: { provider: string; model: string };
  messageId?: string;
}

export interface FoldedV2Agent {
  messages: V2ContextMessage[];
  nextTurnId: number;
  todos: readonly TodoItem[];
  assistantExtras: Map<V2ContextMessage, V2AssistantExtra>;
}

interface V2LoopEvent {
  type: string;
  uuid?: string;
  stepUuid?: string;
  turnId?: string;
  step?: number;
  part?: ContentPart;
  toolCallId?: string;
  name?: string;
  args?: unknown;
  extras?: Record<string, unknown>;
  result?: { output?: unknown; isError?: boolean; note?: string };
  finishReason?: string;
  usage?: TokenUsage;
  rawFinishReason?: string;
  providerFinishReason?: string;
  messageId?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asMessage(value: unknown): V2ContextMessage | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value['role'] !== 'string') return undefined;
  const content = value['content'];
  const toolCalls = value['toolCalls'];
  return {
    ...(value as unknown as V2ContextMessage),
    content: Array.isArray(content) ? (content as ContentPart[]) : [],
    toolCalls: Array.isArray(toolCalls) ? (toolCalls as ToolCall[]) : [],
  };
}

function isVacuousContentPart(part: ContentPart): boolean {
  switch (part.type) {
    case 'text':
      return part.text.trim().length === 0;
    case 'think':
      return part.encrypted === undefined && part.think.trim().length === 0;
    case 'image_url':
    case 'audio_url':
    case 'video_url':
      return false;
    default:
      return false;
  }
}

function isUndoAnchorOrigin(origin: V2PromptOrigin | undefined): boolean {
  if (origin === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

function isUndoAnchor(message: V2ContextMessage): boolean {
  return message.role === 'user' && isUndoAnchorOrigin(message.origin);
}

function isPromptOwnedInjection(message: V2ContextMessage, prompt: V2ContextMessage): boolean {
  const origin = message.origin;
  return (
    origin?.kind === 'injection' &&
    origin.ownerPromptId !== undefined &&
    origin.ownerPromptId === prompt.id
  );
}

function estimateTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if ((char.codePointAt(0) as number) <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

function estimateTokensForMessage(message: V2ContextMessage): number {
  let total = estimateTokens(message.role);
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        total += estimateTokens(part.text);
        break;
      case 'think':
        total += estimateTokens(part.think);
        break;
      case 'image_url':
      case 'audio_url':
      case 'video_url':
        total += MEDIA_TOKEN_ESTIMATE;
        break;
    }
  }
  for (const call of message.toolCalls ?? []) {
    total += estimateTokens(call.name);
    total += estimateTokens(JSON.stringify(call.arguments));
  }
  return total;
}

function extractText(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let end = 0;
  for (const char of text) {
    if ((char.codePointAt(0) as number) <= 127) {
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

function replaceMessageText(message: V2ContextMessage, text: string): V2ContextMessage {
  return { ...message, content: [{ type: 'text', text }], toolCalls: [] };
}

function wrapSystemReminder(content: string): string {
  return `<system-reminder>\n${content.trim()}\n</system-reminder>`;
}

function createCompactionSummaryMessage(text: string): V2ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

function createCompactionElisionMessage(omittedTokens: number): V2ContextMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: wrapSystemReminder(
          `Some of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly ${String(omittedTokens)} tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation.`,
        ),
      },
    ],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'compaction_elision' },
  };
}

function isCompactableUserMessage(message: V2ContextMessage): boolean {
  if (message.role !== 'user') return false;
  if (message.origin?.kind === 'compaction_summary') return false;
  return isUndoAnchorOrigin(message.origin);
}

interface CompactionShapeInput {
  summaryText: string;
  legacySummaryMessage?: V2ContextMessage;
  contextSummary?: string;
  compactedCount: number;
  legacyTail: boolean;
}

function readCompactionShapeInput(record: V2WireRecord): CompactionShapeInput {
  const summary = record['summary'];
  const contextSummary = record['contextSummary'];
  let summaryText: string;
  let legacySummaryMessage: V2ContextMessage | undefined;
  if (typeof summary === 'string') {
    summaryText = summary;
  } else if (typeof contextSummary === 'string') {
    summaryText = contextSummary;
  } else {
    const message = asMessage(summary);
    if (message === undefined) {
      throw new V2WireError(
        'invalid-compaction-record',
        'context.apply_compaction record is missing a usable summary',
      );
    }
    legacySummaryMessage = message;
    summaryText = extractText(message.content);
  }
  const compactedCount = record['compactedCount'];
  const legacyCount = record['count'];
  const count =
    typeof compactedCount === 'number'
      ? compactedCount
      : typeof legacyCount === 'number'
        ? legacyCount
        : undefined;
  if (count === undefined) {
    throw new V2WireError(
      'invalid-compaction-record',
      'context.apply_compaction record is missing compactedCount',
    );
  }
  const legacyTailField = record['legacyTail'];
  const keptUserMessageCount = record['keptUserMessageCount'];
  return {
    summaryText,
    legacySummaryMessage,
    contextSummary: typeof contextSummary === 'string' ? contextSummary : undefined,
    compactedCount: count,
    legacyTail:
      typeof legacyTailField === 'boolean' ? legacyTailField : keptUserMessageCount === undefined,
  };
}

function selectCompactionUserMessages(
  messages: readonly V2ContextMessage[],
  maxTokens: number,
  headTokens: number,
): { head: V2ContextMessage[]; tail: V2ContextMessage[]; elided: boolean; omittedTokens: number } {
  let totalTokens = 0;
  for (const message of messages) {
    totalTokens += estimateTokensForMessage(message);
  }
  if (totalTokens <= maxTokens) {
    return { head: [], tail: [...messages], elided: false, omittedTokens: 0 };
  }
  const headBudget = Math.min(Math.max(headTokens, 0), maxTokens);
  const tailBudget = maxTokens - headBudget;
  const tail: V2ContextMessage[] = [];
  let tailRemaining = tailBudget;
  let headEndExclusive = messages.length;
  let tailBoundaryDroppedPrefix: V2ContextMessage | null = null;
  for (let i = messages.length - 1; i >= 0 && tailRemaining > 0; i--) {
    const message = messages[i] as V2ContextMessage;
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
  const head: V2ContextMessage[] = [];
  let headRemaining = headBudget;
  for (const message of headCandidates) {
    if (headRemaining <= 0) break;
    const tokens = estimateTokensForMessage(message);
    if (tokens <= headRemaining) {
      head.push(message);
      headRemaining -= tokens;
      continue;
    }
    head.push(replaceMessageText(message, truncateTextToTokens(extractText(message.content), headRemaining)));
    break;
  }
  let keptTokens = 0;
  for (const message of head) keptTokens += estimateTokensForMessage(message);
  for (const message of tail) keptTokens += estimateTokensForMessage(message);
  return { head, tail, elided: true, omittedTokens: Math.max(0, totalTokens - keptTokens) };
}

function buildCompactionMessages(
  history: readonly V2ContextMessage[],
  input: CompactionShapeInput,
): V2ContextMessage[] {
  const contextSummary = input.contextSummary ?? input.summaryText;
  if (input.legacyTail) {
    return [
      input.legacySummaryMessage ?? createCompactionSummaryMessage(contextSummary),
      ...history.slice(input.compactedCount),
    ];
  }
  const compactable = history.filter(isCompactableUserMessage);
  const selection = selectCompactionUserMessages(
    compactable,
    COMPACT_USER_MESSAGE_MAX_TOKENS,
    COMPACT_USER_MESSAGE_HEAD_TOKENS,
  );
  const kept = selection.elided
    ? [...selection.head, createCompactionElisionMessage(selection.omittedTokens), ...selection.tail]
    : [...selection.head, ...selection.tail];
  return [...kept, createCompactionSummaryMessage(contextSummary)];
}

interface UndoCut {
  cutIndex: number;
  removedCount: number;
}

function computeUndoCut(state: readonly V2ContextMessage[], count: number): UndoCut {
  let remaining = count;
  let cutIndex = -1;
  let removedCount = 0;
  for (let i = state.length - 1; i >= 0 && remaining > 0; i--) {
    const message = state[i] as V2ContextMessage;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') break;
    if (isUndoAnchor(message)) {
      remaining--;
      removedCount++;
      cutIndex = i;
      while (cutIndex > 0 && isPromptOwnedInjection(state[cutIndex - 1] as V2ContextMessage, message)) {
        cutIndex--;
      }
    }
  }
  return { cutIndex, removedCount };
}

export function foldV2WireRecords(records: readonly V2WireRecord[]): FoldedV2Agent {
  const messages: V2ContextMessage[] = [];
  const assistantExtras = new Map<V2ContextMessage, V2AssistantExtra>();
  let openIndex = -1;
  let openStepUuid: string | undefined;
  let openHasToolCalls = false;
  let openVacuous = true;
  let stepExtra: V2AssistantExtra | undefined;
  let lastModel: { provider: string; model: string } | undefined;
  const pending = new Set<string>();
  let deferred: V2ContextMessage[] = [];
  let todos: readonly TodoItem[] = [];
  let nextTurnId = 0;
  const cancelledTurnIds = new Set<number>();

  const advanceTurnClock = (target: number): void => {
    for (const id of cancelledTurnIds) {
      if (id < target) cancelledTurnIds.delete(id);
    }
    while (cancelledTurnIds.delete(target)) target += 1;
    nextTurnId = target;
  };

  const resetFold = (): void => {
    openIndex = -1;
    openStepUuid = undefined;
    openHasToolCalls = false;
    openVacuous = true;
    stepExtra = undefined;
    pending.clear();
    deferred = [];
  };

  const flushDeferred = (): void => {
    if (pending.size > 0 || deferred.length === 0) return;
    messages.push(...deferred);
    deferred = [];
  };

  const closePending = (): void => {
    if (pending.size === 0) return;
    for (const toolCallId of pending) {
      messages.push({
        role: 'tool',
        content: [{ type: 'text', text: TOOL_INTERRUPTED_ON_RESUME_OUTPUT }],
        toolCalls: [],
        toolCallId,
        isError: true,
      });
    }
    pending.clear();
    flushDeferred();
  };

  const settleOpen = (): void => {
    if (openStepUuid === undefined) return;
    closePending();
    if (openIndex !== -1) {
      const open = messages[openIndex] as V2ContextMessage;
      if (!openHasToolCalls && openVacuous) {
        messages.splice(openIndex, 1);
      } else {
        delete open.partial;
        const extra: V2AssistantExtra = { ...stepExtra, model: stepExtra?.model ?? lastModel };
        if (
          extra.usage !== undefined ||
          extra.finishReason !== undefined ||
          extra.model !== undefined ||
          extra.messageId !== undefined
        ) {
          assistantExtras.set(open, extra);
        }
      }
    }
    openIndex = -1;
    openStepUuid = undefined;
    stepExtra = undefined;
  };

  const acceptsOpenStep = (stepUuid: unknown): stepUuid is string => {
    if (openStepUuid === undefined) return false;
    return stepUuid === openStepUuid;
  };

  const foldLoopEvent = (event: V2LoopEvent): void => {
    switch (event.type) {
      case 'step.begin': {
        settleOpen();
        messages.push({ role: 'assistant', content: [], toolCalls: [], partial: true });
        openIndex = messages.length - 1;
        openStepUuid = event.uuid;
        openHasToolCalls = false;
        openVacuous = true;
        return;
      }
      case 'step.end': {
        if (event.finishReason === 'interrupted' || event.finishReason === 'error') return;
        if (openStepUuid !== undefined) {
          stepExtra = {
            usage: event.usage,
            finishReason: event.finishReason,
            rawFinishReason: event.rawFinishReason,
            providerFinishReason: event.providerFinishReason,
            messageId: event.messageId,
          };
        }
        settleOpen();
        flushDeferred();
        return;
      }
      case 'content.part': {
        if (!acceptsOpenStep(event.stepUuid)) return;
        if (openIndex === -1 || event.part === undefined) return;
        (messages[openIndex] as V2ContextMessage).content.push(event.part);
        openVacuous = openVacuous && isVacuousContentPart(event.part);
        return;
      }
      case 'tool.call': {
        if (!acceptsOpenStep(event.stepUuid)) return;
        if (openIndex === -1 || typeof event.toolCallId !== 'string') return;
        const call: ToolCall = {
          type: 'function',
          id: event.toolCallId,
          name: typeof event.name === 'string' ? event.name : '',
          arguments: event.args === undefined ? null : JSON.stringify(event.args),
          ...(event.extras !== undefined ? { extras: event.extras } : {}),
        };
        (messages[openIndex] as V2ContextMessage).toolCalls?.push(call);
        pending.add(event.toolCallId);
        openHasToolCalls = true;
        return;
      }
      case 'tool.result': {
        const toolCallId = event.toolCallId;
        if (typeof toolCallId !== 'string' || !pending.has(toolCallId)) return;
        pending.delete(toolCallId);
        const output = event.result?.output;
        messages.push({
          role: 'tool',
          content:
            typeof output === 'string'
              ? [{ type: 'text', text: output }]
              : Array.isArray(output)
                ? ([...output] as ContentPart[])
                : [],
          toolCalls: [],
          toolCallId,
          isError: event.result?.isError,
          note: event.result?.note,
        });
        flushDeferred();
        return;
      }
    }
  };

  for (const record of records) {
    switch (record.type) {
      case 'context.append_message': {
        const message = asMessage(record['message']);
        if (message === undefined) continue;
        if (pending.size > 0) {
          deferred.push(message);
        } else {
          messages.push(message);
        }
        break;
      }
      case 'context.append_loop_event': {
        const event = record['event'];
        if (!isObject(event) || typeof event['type'] !== 'string') continue;
        const loopEvent = event as unknown as V2LoopEvent;
        if (loopEvent.type !== 'tool.result' && typeof loopEvent.turnId === 'string') {
          const turnId = Number.parseInt(loopEvent.turnId, 10);
          if (Number.isInteger(turnId) && turnId >= nextTurnId) {
            advanceTurnClock(turnId + 1);
          }
        }
        foldLoopEvent(loopEvent);
        break;
      }
      case 'context.clear': {
        messages.length = 0;
        resetFold();
        break;
      }
      case 'context.undo': {
        const count = record['count'] as number;
        if (messages.length === 0) break;
        const cut = computeUndoCut(messages, count);
        if (cut.cutIndex < 0 || cut.removedCount < count) break;
        messages.length = cut.cutIndex;
        resetFold();
        break;
      }
      case 'context.apply_compaction': {
        const input = readCompactionShapeInput(record);
        const compacted = buildCompactionMessages(messages, input);
        messages.length = 0;
        messages.push(...compacted);
        resetFold();
        break;
      }
      case 'turn.prompt': {
        advanceTurnClock(nextTurnId + 1);
        break;
      }
      case 'turn.cancel': {
        const target = record['target'];
        const turnId = record['turnId'];
        if (target === undefined || typeof turnId !== 'number' || turnId < nextTurnId) break;
        cancelledTurnIds.add(turnId);
        advanceTurnClock(nextTurnId);
        break;
      }
      case 'llm.request': {
        lastModel = { provider: record['provider'] as string, model: record['model'] as string };
        break;
      }
      case 'tools.update_store': {
        if (record['key'] !== 'todo') break;
        todos = readTodoItems(record['value']);
        break;
      }
    }
  }

  settleOpen();
  flushDeferred();

  return { messages, nextTurnId, todos, assistantExtras };
}
