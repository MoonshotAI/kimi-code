import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

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

export type MediaSource =
  | { readonly kind: 'store'; readonly ref: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'inline'; readonly mimeType: string; readonly data: string }
  | { readonly kind: 'file'; readonly id: string; readonly mimeType: string };

export type MediaOmission = 'degraded' | 'stripped' | 'budget';

export interface MediaPartBase extends ContentPartBase {
  source: MediaSource;
  omitted?: MediaOmission;
}

export interface ImageURLPart extends MediaPartBase {
  type: 'image_url';
  name?: string;
}

export interface AudioURLPart extends MediaPartBase {
  type: 'audio_url';
}

export interface VideoURLPart extends MediaPartBase {
  type: 'video_url';
  name?: string;
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

function mediaIdentityOf(source: MediaSource): string {
  switch (source.kind) {
    case 'store':
      return source.ref;
    case 'url':
      return source.url;
    case 'file':
      return source.id;
    case 'inline':
      return bytesToHex(sha256(utf8ToBytes(`${source.mimeType}\0${source.data}`)));
  }
}

export function mediaKeyOf(part: MediaPart): string {
  return `${part.type}\0${part.source.kind}\0${mediaIdentityOf(part.source)}`;
}

export type MediaPlaceholderReason = MediaOmission | 'unsupported' | 'protocol_unsupported' | 'unavailable';

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
