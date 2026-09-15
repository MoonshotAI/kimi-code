import type {
  AssistantMessage,
  ContentPart,
  Message as LlmMessage,
  Role,
  ToolCall,
  ToolDescription,
} from '#human/llm/message';

export type {
  AudioURLPart,
  ContentPart,
  ImageURLPart,
  Role,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from '#human/llm/message';

export type Tool = ToolDescription;

export {
  extractText,
  getTextContent,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
} from '#human/llm/message';

export interface Message {
  readonly role: Role;
  readonly name?: string;
  readonly content: ContentPart[];
  readonly toolCalls: ToolCall[];
  readonly toolCallId?: string;
  readonly partial?: boolean;
  readonly tools?: readonly Tool[];
}

export function isToolDeclarationOnlyMessage(message: Message): boolean {
  return (
    message.tools !== undefined &&
    message.tools.length > 0 &&
    message.content.length === 0 &&
    message.toolCalls.length === 0
  );
}

export function createUserMessage(content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: content }],
    toolCalls: [],
  };
}

export function createAssistantMessage(content: ContentPart[], toolCalls?: ToolCall[]): Message {
  return {
    role: 'assistant',
    content,
    toolCalls: toolCalls ?? [],
  };
}

export function createToolMessage(toolCallId: string, output: string | ContentPart[]): Message {
  const content: ContentPart[] =
    typeof output === 'string' ? [{ type: 'text', text: output }] : output;
  return {
    role: 'tool',
    content,
    toolCalls: [],
    toolCallId,
  };
}

export function toLlmMessage(message: Message): LlmMessage {
  switch (message.role) {
    case 'system':
      return {
        role: 'system',
        content: message.content,
        tools: message.tools === undefined ? undefined : [...message.tools],
      };
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant':
      return { role: 'assistant', content: message.content, toolCalls: message.toolCalls };
    case 'tool':
      return { role: 'tool', content: message.content, toolCallId: message.toolCallId ?? '' };
  }
}

export function fromLlmMessage(message: LlmMessage): Message {
  switch (message.role) {
    case 'system':
      return {
        role: 'system',
        content: message.content,
        toolCalls: [],
        tools: message.tools,
      };
    case 'user':
      return { role: 'user', content: message.content, toolCalls: [] };
    case 'assistant':
      return { role: 'assistant', content: message.content, toolCalls: message.toolCalls };
    case 'tool':
      return { role: 'tool', content: message.content, toolCalls: [], toolCallId: message.toolCallId };
  }
}

export function fromLlmAssistantMessage(message: AssistantMessage): Message {
  return {
    role: 'assistant',
    content: message.content,
    toolCalls: message.toolCalls,
  };
}
