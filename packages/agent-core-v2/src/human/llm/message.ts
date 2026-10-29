export interface ToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferred?: true;
}

export interface ContentPartMeta {
  readonly kind?: string;
  readonly [key: string]: unknown;
}

export interface ContentPartBase {
  contentType?: string;
  meta?: ContentPartMeta;
}

export interface TextPart extends ContentPartBase {
  type: 'text';
  text: string;
}

export interface ThinkPart extends ContentPartBase {
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

export type MediaPart = ImageURLPart | AudioURLPart | VideoURLPart;

export function isMediaPart(part: ContentPart): part is MediaPart {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

export type MediaKind = 'image' | 'video' | 'audio';

export function mediaKindOfPart(part: MediaPart): MediaKind {
  if (part.type === 'image_url') return 'image';
  if (part.type === 'video_url') return 'video';
  return 'audio';
}

export function mediaKeyOf(part: MediaPart): string {
  const media = part.type === 'image_url'
    ? part.imageUrl
    : part.type === 'audio_url'
      ? part.audioUrl
      : part.videoUrl;
  return `${part.type}\0${media.id ?? ''}\0${media.url}`;
}

export type MediaPlaceholderReason =
  | 'degraded'
  | 'stripped'
  | 'budget'
  | 'unsupported'
  | 'protocol_unsupported'
  | 'unavailable';

const MEDIA_PLACEHOLDER_TEXT: Readonly<
  Record<MediaPlaceholderReason, Readonly<Record<MediaKind, string>>>
> = {
  degraded: {
    image: '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
    audio: '[audio omitted: dropped to fit the provider request size limit; re-read the file to hear it]',
    video: '[video omitted: dropped to fit the provider request size limit; re-read the file to view it]',
  },
  stripped: {
    image: '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]',
    audio: '[audio omitted for provider compatibility; re-read the file to hear it]',
    video: '[video omitted for provider compatibility; re-read the file to view it]',
  },
  budget: {
    image: '[image omitted: dropped to fit the request media budget]',
    audio: '[audio omitted: dropped to fit the request media budget]',
    video: '[video omitted: dropped to fit the request media budget]',
  },
  unsupported: {
    image: '[image omitted: not supported by this model]',
    audio: '[audio omitted: not supported by this model]',
    video: '[video omitted: not supported by this model]',
  },
  protocol_unsupported: {
    image: '[image omitted: not supported by this provider]',
    audio: '[audio omitted: not supported by this provider]',
    video: '[video omitted: not supported by this provider]',
  },
  unavailable: {
    image: '[image omitted: media unavailable]',
    audio: '[audio omitted: media unavailable]',
    video: '[video omitted: media unavailable]',
  },
};

export function mediaPlaceholderText(kind: MediaKind, reason: MediaPlaceholderReason): string {
  return MEDIA_PLACEHOLDER_TEXT[reason][kind];
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
  }
}

export function extractText(message: { readonly content: readonly ContentPart[] }, sep: string = ''): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join(sep);
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

function samePartIdentity(target: ContentPartBase, source: ContentPartBase): boolean {
  if (
    source.contentType !== undefined &&
    target.contentType !== undefined &&
    source.contentType !== target.contentType
  ) {
    return false;
  }
  if (source.meta !== undefined && target.meta !== undefined && source.meta !== target.meta) {
    if (source.meta.kind !== target.meta.kind) return false;
    const sourceKeys = Object.keys(source.meta);
    const targetKeys = Object.keys(target.meta);
    if (sourceKeys.length !== targetKeys.length) return false;
    for (const key of sourceKeys) {
      if (source.meta[key] !== target.meta[key]) return false;
    }
  }
  return true;
}

export function mergeInPlace(target: StreamedMessagePart, source: StreamedMessagePart): boolean {
  if (target.type === 'text' && source.type === 'text') {
    if (!samePartIdentity(target, source)) return false;
    target.text += source.text;
    target.contentType ??= source.contentType;
    target.meta ??= source.meta;
    return true;
  }

  if (target.type === 'think' && source.type === 'think') {
    if (target.encrypted !== undefined) return false;
    if (target.detailsIndex !== source.detailsIndex) return false;
    if (target.hidden !== source.hidden) return false;
    if (target.reasoningKey !== source.reasoningKey) return false;
    if (!samePartIdentity(target, source)) return false;
    target.think += source.think;
    if (source.encrypted !== undefined) target.encrypted = source.encrypted;
    target.contentType ??= source.contentType;
    target.meta ??= source.meta;
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

export function salvageInterruptedMessage(message: AssistantMessage): AssistantMessage | null {
  const content = message.content.filter((part) => !isVacuousContentPart(part));
  if (content.length === 0) return null;
  return { role: 'assistant', content, toolCalls: [] };
}

export interface MessageAccumulator {
  push(part: StreamedMessagePart): void;
  toolCallEnd(index?: number | string): ToolCall | undefined;
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
      if (part.type === 'text') deferredThink = null;
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
    toolCallEnd(index) {
      if (
        pending === null ||
        !isToolCall(pending) ||
        (index !== undefined && pending._streamIndex !== index)
      ) {
        return undefined;
      }
      flush();
      return message.toolCalls[message.toolCalls.length - 1];
    },
    finish(): AssistantMessage {
      flush();
      return message;
    },
  };
}
