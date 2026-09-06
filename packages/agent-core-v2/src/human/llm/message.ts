export interface ToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferred?: true;
}

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkPart {
  type: 'think';
  think: string;
  encrypted?: string;
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
      return part.encrypted === undefined && part.think.trim().length === 0;
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
  const flush = () => {
    if (pending === null) {
      return;
    }
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
      });
      if (pending._streamIndex !== undefined) {
        toolCallIndexMap.set(pending._streamIndex, ordinal);
      }
    }
    pending = null;
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
      if (pending === null) {
        pending = structuredClone(part);
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
