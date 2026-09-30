import { isVacuousContentPart } from '#/llm/message';
import type {
  AssistantMessage,
  ContentPart,
  ContentPartMeta,
  Message,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from '#/llm/message';
import type { FinishInfo, TokenUsage } from '#/llm/response';

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

export function salvageInterruptedMessage(message: AssistantMessage): AssistantMessage | null {
  const content = message.content.filter((part) => !isVacuousContentPart(part));
  if (content.length === 0) {
    return null;
  }
  return { role: 'assistant', content, toolCalls: [] };
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

export interface ToolMeta extends EntryMeta {
  isError?: true;
}

export interface AssistantMeta extends EntryMeta {
  model?: { provider: string; model: string };
  usage?: TokenUsage;
  headers?: Record<string, string>;
  finish?: FinishInfo;
  messageId?: string;
}

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

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
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

export function toRequestMessages(history: readonly HistoryMessage[]): Message[] {
  return history.map((entry) =>
    entry.message.role === 'tool'
      ? {
          ...entry.message,
          content: renderToolResultForModel({
            output: entry.message.content,
            isError: (entry.meta as ToolMeta | undefined)?.isError === true,
          }),
        }
      : entry.message,
  );
}
