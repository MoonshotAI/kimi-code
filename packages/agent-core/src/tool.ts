import type { ContentPart, ToolCall, ToolDescription } from '#/llm/message';

export interface ToolUpdate {
  key: string;
  text: string;
  percent?: number;
}

export interface ToolResult {
  content: ContentPart[];
}

export interface ToolInput {
  toolCall: ToolCall;
  signal: AbortSignal;
}

export interface ToolExecuteInput extends ToolInput {
  onUpdate?: (update: ToolUpdate) => void;
  detach?: (text: string) => void;
}

export interface ToolDefinition extends ToolDescription {
  execute(input: ToolExecuteInput): Promise<ToolResult>;
}

export type ToolExecutor = Pick<ToolDefinition, 'execute'>;
