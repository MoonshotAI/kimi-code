import type {
  ContentPart as CoreContentPart,
  Message as CoreMessage,
  StreamedMessagePart as CoreStreamedMessagePart,
} from '#/llm/message';

export interface ToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferred?: true;
}

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type TextPartMeta = {
  source?: string;
  contentType?: string;
  activationId?: string;
  [key: string]: unknown;
};

export interface TextPart {
  type: 'text';
  text: string;
  meta?: TextPartMeta;
}

export interface ThinkPart {
  type: 'think';
  think: string;
  encrypted?: string;
  detailsIndex?: number;
  hidden?: boolean;
  reasoningKey?: string;
}

export interface ImageURLPart {
  type: 'image_url';
  imageUrl: { url: string; id?: string; name?: string };
}

export interface AudioURLPart {
  type: 'audio_url';
  audioUrl: { url: string; id?: string };
}

export interface VideoURLPart {
  type: 'video_url';
  videoUrl: { url: string; id?: string; name?: string };
}

export type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart | VideoURLPart;

export interface ToolCall {
  type: 'function';
  id: string;
  name: string;
  arguments: string | null;
  extras?: Record<string, unknown>;
  rawId?: string;
  _streamIndex?: number | string;
}

export interface ToolCallPart {
  type: 'tool_call_part';
  argumentsPart: string | null;
  index?: number | string;
}

export type StreamedMessagePart = ContentPart | ToolCall | ToolCallPart;

export interface SystemMessage {
  readonly role: 'system';
  content: ContentPart[];
  readonly tools?: ToolDescription[];
}

export interface UserMessage {
  readonly role: 'user';
  content: ContentPart[];
}

export interface AssistantMessage {
  readonly role: 'assistant';
  content: ContentPart[];
  toolCalls: ToolCall[];
}

export interface ToolMessage {
  readonly role: 'tool';
  content: ContentPart[];
  readonly toolCallId: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export function isContentPart(part: StreamedMessagePart): part is ContentPart {
  const t = part.type;
  return (
    t === 'text' || t === 'think' || t === 'image_url' || t === 'audio_url' || t === 'video_url'
  );
}

export function isToolCall(part: StreamedMessagePart): part is ToolCall {
  return part.type === 'function';
}

export function isToolCallPart(part: StreamedMessagePart): part is ToolCallPart {
  return part.type === 'tool_call_part';
}

export function mergeInPlace(target: StreamedMessagePart, source: StreamedMessagePart): boolean {
  if (target.type === 'text' && source.type === 'text') {
    target.text += source.text;
    return true;
  }

  if (target.type === 'think' && source.type === 'think') {
    if (target.encrypted !== undefined) {
      return false;
    }
    if (target.detailsIndex !== source.detailsIndex) {
      return false;
    }
    if (target.hidden !== source.hidden) {
      return false;
    }
    if (target.reasoningKey !== source.reasoningKey) {
      return false;
    }
    target.think += source.think;
    if (source.encrypted !== undefined) {
      target.encrypted = source.encrypted;
    }
    return true;
  }

  if (target.type === 'function' && source.type === 'tool_call_part') {
    if (source.argumentsPart !== null) {
      target.arguments =
        target.arguments === null
          ? source.argumentsPart
          : target.arguments + source.argumentsPart;
    }
    return true;
  }

  return false;
}

export function extractText(message: { readonly content: readonly ContentPart[] }, sep: string = ''): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join(sep);
}

export function getTextContent(message: { readonly content: readonly ContentPart[] }): string {
  return extractText(message);
}

export function createUserMessage(content: string): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: content }],
  };
}

export function createAssistantMessage(
  content: ContentPart[],
  toolCalls?: ToolCall[],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    toolCalls: toolCalls ?? [],
  };
}

export function createToolMessage(toolCallId: string, output: string | ContentPart[]): ToolMessage {
  const content: ContentPart[] =
    typeof output === 'string' ? [{ type: 'text', text: output }] : output;
  return {
    role: 'tool',
    content,
    toolCallId,
  };
}

export function isVacuousContentPart(part: ContentPart): boolean {
  switch (part.type) {
    case 'text':
      return part.text.trim().length === 0;
    case 'think':
      return part.encrypted === undefined && part.hidden !== true && part.think.trim().length === 0;
    case 'image_url':
    case 'audio_url':
    case 'video_url':
      return false;
    default: {
      const exhaustive: never = part;
      void exhaustive;
      return false;
    }
  }
}

export function salvageInterruptedMessage(message: AssistantMessage): AssistantMessage | null {
  const content = message.content.filter((part) => !isVacuousContentPart(part));
  if (content.length === 0) {
    return null;
  }
  return { role: 'assistant', content, toolCalls: [] };
}

export interface MessageAccumulator {
  push(part: StreamedMessagePart): void;
  finish(): AssistantMessage;
}

export function createMessageAccumulator(): MessageAccumulator {
  const message: AssistantMessage = { role: 'assistant', content: [], toolCalls: [] };
  const toolCallIndexMap = new Map<number | string, number>();
  let pending: StreamedMessagePart | null = null;
  let deferredThink: ThinkPart | null = null;
  const flush = () => {
    if (pending !== null) {
      if (isContentPart(pending)) {
        message.content.push(pending);
      } else if (isToolCall(pending)) {
        const ordinal = message.toolCalls.length;
        message.toolCalls.push({
          type: 'function',
          id: pending.id,
          name: pending.name,
          arguments: pending.arguments,
          extras: pending.extras,
          rawId: pending.rawId,
        });
        if (pending._streamIndex !== undefined) {
          toolCallIndexMap.set(pending._streamIndex, ordinal);
        }
      }
      pending = null;
    }
    if (deferredThink !== null) {
      message.content.push(deferredThink);
      deferredThink = null;
    }
  };
  return {
    push(part: StreamedMessagePart) {
      if (
        isToolCallPart(part) &&
        part.index !== undefined &&
        !(pending !== null && isToolCall(pending) && pending._streamIndex === part.index)
      ) {
        const arrayIndex = toolCallIndexMap.get(part.index);
        if (arrayIndex !== undefined) {
          const target = message.toolCalls[arrayIndex];
          if (target !== undefined && part.argumentsPart !== null) {
            target.arguments =
              target.arguments === null
                ? part.argumentsPart
                : target.arguments + part.argumentsPart;
          }
          return;
        }
      }
      if (part.type === 'text') {
        deferredThink = null;
      }
      if (pending === null) {
        pending = structuredClone(part);
        return;
      }
      if (pending.type === 'text' && part.type === 'think' && isVacuousContentPart(part)) {
        deferredThink = structuredClone(part);
        return;
      }
      if (!mergeInPlace(pending, part)) {
        flush();
        pending = structuredClone(part);
      }
    },
    finish(): AssistantMessage {
      flush();
      return message;
    },
  };
}

export function toCorePart(part: ContentPart): CoreContentPart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text, meta: part.meta };
    case 'think':
      return {
        type: 'think',
        think: part.think,
        encrypted: part.encrypted,
        detailsIndex: part.detailsIndex,
        hidden: part.hidden,
        reasoningKey: part.reasoningKey,
      };
    case 'image_url':
      return { type: 'image_url', imageUrl: { ...part.imageUrl } };
    case 'audio_url':
      return { type: 'audio_url', audioUrl: { ...part.audioUrl } };
    case 'video_url':
      return { type: 'video_url', videoUrl: { ...part.videoUrl } };
  }
}

export function toCoreMessage(message: Message): CoreMessage {
  const content = message.content.map(toCorePart);
  switch (message.role) {
    case 'system':
      return { role: 'system', content, tools: message.tools };
    case 'user':
      return { role: 'user', content };
    case 'assistant':
      return {
        role: 'assistant',
        content,
        toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
      };
    case 'tool':
      return { role: 'tool', content, toolCallId: message.toolCallId };
  }
}

export function fromCorePart(part: CoreContentPart): ContentPart;
export function fromCorePart(part: CoreStreamedMessagePart): StreamedMessagePart;
export function fromCorePart(part: CoreStreamedMessagePart): StreamedMessagePart {
  switch (part.type) {
    case 'text':
      return {
        type: 'text',
        text: part.text,
        ...(part.meta === undefined ? {} : { meta: part.meta }),
      };
    case 'think':
      return {
        type: 'think',
        think: part.think,
        ...(part.encrypted === undefined ? {} : { encrypted: part.encrypted }),
        ...(part.detailsIndex === undefined ? {} : { detailsIndex: part.detailsIndex }),
        ...(part.hidden === undefined ? {} : { hidden: part.hidden }),
        ...(part.reasoningKey === undefined ? {} : { reasoningKey: part.reasoningKey }),
      };
    case 'image_url':
      return { type: 'image_url', imageUrl: { ...part.imageUrl } };
    case 'audio_url':
      return { type: 'audio_url', audioUrl: { ...part.audioUrl } };
    case 'video_url':
      return { type: 'video_url', videoUrl: { ...part.videoUrl } };
    case 'function':
    case 'tool_call_part':
      return { ...part };
  }
}

export function fromCoreMessage(message: CoreMessage): Message {
  const content = message.content.map((part) => fromCorePart(part));
  switch (message.role) {
    case 'system':
      return {
        role: 'system',
        content,
        ...(message.tools === undefined ? {} : { tools: message.tools }),
      };
    case 'user':
      return { role: 'user', content };
    case 'assistant':
      return { role: 'assistant', content, toolCalls: message.toolCalls };
    case 'tool':
      return { role: 'tool', content, toolCallId: message.toolCallId };
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fromPersistentMessage(value: unknown): CoreMessage {
  return toCoreMessage(value as Message);
}

function mapEntry(
  value: unknown,
  mapMessage: (message: never) => unknown,
): unknown {
  if (!isRecord(value) || !('message' in value)) return value;
  return { ...value, message: mapMessage(value['message'] as never) };
}

function mapHistoryRecord(
  type: string,
  record: UnknownRecord,
  mapMessage: (message: never) => unknown,
): UnknownRecord {
  if (type === 'message.appended') {
    return { ...record, message: mapEntry(record['message'], mapMessage) };
  }
  if (type === 'input.submitted' || type === 'input.notified') {
    const { entry, ...rest } = record;
    const output: UnknownRecord = {
      ...rest,
      message: record['message'] === undefined ? undefined : mapMessage(record['message'] as never),
    };
    if (entry !== undefined) output['entry'] = mapEntry(entry, mapMessage);
    return output;
  }
  if (type === 'input.reminded') {
    const message = record['message'];
    return {
      ...record,
      message: isRecord(message) && 'role' in message
        ? mapMessage(message as never)
        : mapEntry(message, mapMessage),
    };
  }
  if (type === 'input.steered') {
    return { ...record, message: mapMessage(record['message'] as never) };
  }
  return record;
}

export function historyRecordToPersistent(
  type: string,
  record: UnknownRecord,
): UnknownRecord {
  return mapHistoryRecord(type, record, (message) => fromCoreMessage(message));
}

export function historyRecordFromPersistent(
  type: string,
  record: UnknownRecord,
): UnknownRecord {
  return mapHistoryRecord(type, record, fromPersistentMessage);
}
