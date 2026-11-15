/**
 * Core message model: content parts (text, think, media), tool calls and their streamed fragments, the
 * four message roles with optional runtime `MessageAttributes`, tool-result model rendering, and the
 * accumulator that merges streamed parts into an assistant message.
 */
import type { TokenUsage } from '#/llm/usage';

export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

export interface FinishInfo {
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
}

export interface PromptOrigin {
  readonly kind: string;
}

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

export interface MessageAttributes {
  source?: string;
  key?: string;
  origin?: PromptOrigin;
  partial?: true;
  llmTiming?: {
    llmFirstTokenLatencyMs?: number;
    llmStreamDurationMs?: number;
  };
  note?: string;
  durationMs?: number;
}

export type SystemMessageAttributes = MessageAttributes;

export interface UserMessageAttributes extends MessageAttributes {
  promptId?: string;
  origin?: PromptOrigin;
  createdAt?: string;
  userMessageId?: string;
  toolCallId?: string;
  bypassMaxSteps?: boolean;
}

export interface ToolMessageAttributes extends MessageAttributes {
  isError?: true;
  stopTurn?: true;
  detached?: true;
}

export interface AssistantMessageAttributes extends MessageAttributes {
  model?: { provider: string; model: string };
  usage?: TokenUsage;
  headers?: Record<string, string>;
  finish?: FinishInfo;
  messageId?: string;
}

export interface SystemMessage {
  readonly role: 'system';
  content: ContentPart[];
  readonly tools?: ToolDescription[];
  attributes?: SystemMessageAttributes;
}

export interface UserMessage {
  readonly role: 'user';
  content: ContentPart[];
  attributes?: UserMessageAttributes;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  content: ContentPart[];
  toolCalls: ToolCall[];
  attributes?: AssistantMessageAttributes;
}

export interface ToolMessage {
  readonly role: 'tool';
  content: ContentPart[];
  readonly toolCallId: string;
  attributes?: ToolMessageAttributes;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export function isVacuousContentPart(part: ContentPart): boolean {
  switch (part.type) {
    case 'text':
      return part.meta?.['thought_signature_b64'] === undefined && part.text.trim().length === 0;
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

export function createSystemMessage(
  content: string | ContentPart[],
  attributes?: SystemMessageAttributes,
  tools?: ToolDescription[],
): SystemMessage {
  return {
    role: 'system',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    ...(tools === undefined ? {} : { tools }),
    ...(attributes === undefined ? {} : { attributes }),
  };
}

export function createUserMessage(
  content: string | ContentPart[],
  attributes?: UserMessageAttributes,
): UserMessage {
  return {
    role: 'user',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    ...(attributes === undefined ? {} : { attributes }),
  };
}

export function createAssistantMessage(
  content: ContentPart[],
  toolCalls?: ToolCall[],
  attributes?: AssistantMessageAttributes,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    toolCalls: toolCalls ?? [],
    ...(attributes === undefined ? {} : { attributes }),
  };
}

export function createToolMessage(
  toolCallId: string,
  output: string | ContentPart[],
  attributes?: ToolMessageAttributes,
): ToolMessage {
  const content: ContentPart[] =
    typeof output === 'string' ? [{ type: 'text', text: output }] : output;
  return {
    role: 'tool',
    content,
    toolCallId,
    ...(attributes === undefined ? {} : { attributes }),
  };
}

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS = '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

export interface RenderableToolResult {
  readonly output: string | readonly ContentPart[];
  readonly isError?: boolean;
}

export function renderToolResultForModel(result: RenderableToolResult): ContentPart[] {
  const output = result.output;
  const sourcePart = typeof output === 'string' ? undefined : output[0];
  const single =
    typeof output === 'string'
      ? output
      : output.length === 1 && sourcePart?.type === 'text'
        ? sourcePart.text
        : undefined;
  if (single !== undefined) {
    if (result.isError === true) {
      if (single.length === 0) return [{ type: 'text', text: TOOL_EMPTY_ERROR_STATUS }];
      return [{ type: 'text', text: TOOL_ERROR_STATUS + '\n' + single }];
    }
    const trimmed = single.trim();
    if (trimmed.length === 0 || trimmed === TOOL_OUTPUT_EMPTY_TEXT) {
      return [{ type: 'text', text: TOOL_EMPTY_STATUS }];
    }
    return [sourcePart ?? { type: 'text', text: single }];
  }
  const parts = output as readonly ContentPart[];
  if (parts.every((part) => part.type === 'text' && part.text.trim().length === 0)) {
    return [{ type: 'text', text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS }];
  }
  if (result.isError === true) return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...parts];
  return [...parts];
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
    if (
      target.meta?.['thought_signature_b64'] !== undefined ||
      source.meta?.['thought_signature_b64'] !== undefined
    ) {
      return false;
    }
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

/**
 * Removes vacuous content and all tool calls from an interrupted assistant message, returning `null`
 * when no meaningful content remains.
 *
 * @example
 * // Input:
 * {
 *   role: 'assistant',
 *   content: [
 *     { type: 'text', text: ' ' }, // ←
 *     { type: 'text', text: 'Partial answer' },
 *   ],
 *   toolCalls: [
 *     { type: 'function', id: 'call-1', name: 'read', arguments: '{}' }, // ←
 *   ],
 * }
 * // Output:
 * {
 *   role: 'assistant',
 *   content: [{ type: 'text', text: 'Partial answer' }], // ←
 *   toolCalls: [], // ←
 * }
 */
export function salvageInterruptedMessage(message: AssistantMessage): AssistantMessage | null {
  const content = message.content.filter((part) => !isVacuousContentPart(part));
  if (content.length === 0) return null;
  return {
    role: 'assistant',
    content,
    toolCalls: [],
    ...(message.attributes === undefined ? {} : { attributes: message.attributes }),
  };
}

export interface MessageAccumulator {
  push(part: StreamedMessagePart): { part: StreamedMessagePart; block: number | undefined };
  toolCallEnd(index?: number | string): ToolCall | undefined;
  finish(): AssistantMessage;
}

export function createMessageAccumulator(): MessageAccumulator {
  const message: AssistantMessage = { role: 'assistant', content: [], toolCalls: [] };
  const toolCallIndexMap = new Map<number | string, number>();
  let pending: StreamedMessagePart | null = null;
  let pendingBlock: number | undefined;
  let deferredThink: ThinkPart | null = null;
  const open = (part: StreamedMessagePart) => {
    const opened = structuredClone(part);
    pending = opened;
    pendingBlock = isContentPart(opened) ? message.content.length : undefined;
    return { part: opened, block: pendingBlock };
  };
  const flush = () => {
    if (pending !== null) {
      if (isContentPart(pending)) {
        message.content.push(pending);
      } else if (isToolCall(pending)) {
        const ordinal = message.toolCalls.length;
        const toolCall: ToolCall = {
          type: 'function',
          id: pending.id,
          name: pending.name,
          arguments: pending.arguments,
        };
        if (pending.extras !== null && pending.extras !== undefined) toolCall.extras = pending.extras;
        if (pending.rawId !== undefined) toolCall.rawId = pending.rawId;
        message.toolCalls.push(toolCall);
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
          return { part, block: undefined };
        }
      }
      if (part.type === 'text') deferredThink = null;
      if (pending === null) return open(part);
      if (pending.type === 'text' && part.type === 'think' && isVacuousContentPart(part)) {
        deferredThink = structuredClone(part);
        return { part: deferredThink, block: undefined };
      }
      if (!mergeInPlace(pending, part)) {
        flush();
        return open(part);
      }
      return { part: pending, block: pendingBlock };
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
      return message.toolCalls.at(-1);
    },
    finish(): AssistantMessage {
      flush();
      return message;
    },
  };
}
