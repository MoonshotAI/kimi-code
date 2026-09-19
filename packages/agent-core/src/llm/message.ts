import type { FinishInfo, TokenUsage } from '#/llm/usage';

export interface ToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferred?: true;
}

export type Role = 'system' | 'user' | 'assistant' | 'tool';

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

export interface ImageURLPart extends ContentPartBase {
  type: 'image_url';
  imageUrl: { url: string; name?: string };
}

export interface AudioURLPart extends ContentPartBase {
  type: 'audio_url';
  audioUrl: { url: string };
}

export interface VideoURLPart extends ContentPartBase {
  type: 'video_url';
  videoUrl: { url: string; name?: string };
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
    if (!samePartIdentity(target, source)) return false;
    target.think += source.think;
    if (source.encrypted !== undefined) {
      target.encrypted = source.encrypted;
    }
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

export type TextContentType = 'text/xml' | 'text/markdown' | 'text/plain';

export function systemReminderText(content: string): string {
  return `<system-reminder>\n${content.trim()}\n</system-reminder>`;
}

export class HistoryMessageBuilder {
  private readonly content: ContentPart[] = [];

  plain(text: string, meta?: ContentPartMeta): this {
    return this.appendText(text, 'text/plain', meta);
  }

  markdown(text: string, meta?: ContentPartMeta): this {
    return this.appendText(text, 'text/markdown', meta);
  }

  xml(text: string, contentType: TextContentType = 'text/xml', meta?: ContentPartMeta): this {
    return this.appendText(text, contentType, meta);
  }

  systemReminder(content: string): this {
    return this.xml(systemReminderText(content), 'text/xml', { kind: 'reminder' });
  }

  parts(): readonly ContentPart[] {
    return [...this.content];
  }

  userMessage(): UserMessage {
    return { role: 'user', content: [...this.content] };
  }

  private appendText(text: string, contentType: TextContentType, meta?: ContentPartMeta): this {
    this.content.push({ type: 'text', text, contentType, meta });
    return this;
  }
}

export function createHistoryMessageBuilder(): HistoryMessageBuilder {
  return new HistoryMessageBuilder();
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

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface PromptFileAttachment {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly path: string;
}

export interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export type SkillPartMeta = BundledSkillActivation & {
  readonly kind: 'skill';
};

export interface UserPromptOrigin {
  readonly kind: 'user';
  readonly attachments?: readonly PromptFileAttachment[];
}

export const USER_PROMPT_ORIGIN: UserPromptOrigin = { kind: 'user' };

export interface PromptOrigin {
  readonly kind: string;
}

export interface SteerMessage {
  readonly content: readonly ContentPart[];
  readonly origin?: PromptOrigin;
}

function userOriginOf(origin: PromptOrigin | undefined): UserPromptOrigin | undefined {
  return origin !== undefined && origin.kind === 'user' ? (origin as UserPromptOrigin) : undefined;
}

export function isSkillPart(part: ContentPart): part is ContentPart & { meta: SkillPartMeta } {
  return part.meta?.kind === 'skill';
}

export function stripBundledSkillBlocks(message: {
  readonly content: readonly ContentPart[];
}): ContentPart[] {
  return message.content.filter((part) => !isSkillPart(part));
}

export function mergeSteerMessages(messages: readonly SteerMessage[]): {
  role: 'user';
  content: ContentPart[];
  toolCalls: [];
  origin: UserPromptOrigin;
} {
  const attachments = messages.flatMap((message) => userOriginOf(message.origin)?.attachments ?? []);
  return {
    role: 'user',
    content: [
      ...messages.flatMap((message) => message.content.filter(isSkillPart)),
      ...messages.flatMap((message) => stripBundledSkillBlocks(message)),
    ],
    toolCalls: [],
    origin:
      attachments.length === 0 ? USER_PROMPT_ORIGIN : { kind: 'user', attachments },
  };
}

export interface EntryMeta {
  source?: string;
  key?: string;
}

export type SystemMeta = EntryMeta;

export interface UserMeta extends EntryMeta {
  promptId?: string;
  origin?: PromptOrigin;
  tracked?: boolean;
  createdAt?: string;
  userMessageId?: string;
}

export type ToolMeta = EntryMeta;

export interface AssistantMeta extends EntryMeta {
  model?: { provider: string; model: string };
  usage: TokenUsage;
  headers?: Record<string, string>;
  finish?: FinishInfo;
  messageId?: string;
}

export type AssistantMetaInput = Omit<AssistantMeta, 'usage'> & { usage?: TokenUsage };

export interface HistoryEntry<T extends Message, F extends EntryMeta> {
  message: T;
  meta?: F;
}

export type SystemEntry = HistoryEntry<SystemMessage, SystemMeta>;

export type UserEntry = HistoryEntry<UserMessage, UserMeta>;

export type ToolEntry = HistoryEntry<ToolMessage, ToolMeta>;

export type AssistantEntry = HistoryEntry<AssistantMessage, AssistantMeta>;

export type HistoryMessage = SystemEntry | UserEntry | AssistantEntry | ToolEntry;

export function createUserEntry(message: UserMessage, meta: UserMeta = {}): UserEntry {
  return { message, meta };
}

export function createSystemEntry(message: SystemMessage, meta: SystemMeta = {}): SystemEntry {
  return { message, meta };
}

export function createToolEntry(message: ToolMessage, meta: ToolMeta = {}): ToolEntry {
  return { message, meta };
}

export function createAssistantEntry(
  message: AssistantMessage,
  meta: AssistantMeta,
): AssistantEntry {
  return { message, meta };
}

export function toInputMessages(history: readonly HistoryMessage[]): Message[] {
  return history.map((entry) => entry.message);
}
