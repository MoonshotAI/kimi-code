import type { ContentPart, ToolCall, ToolDescription } from '#/llm/message';

export interface ToolUpdate {
  key: string;
  text: string;
  percent?: number;
}

export interface ToolResult {
  content: ContentPart[];
  isError?: true;
  stopTurn?: boolean;
}

export interface ToolInput {
  toolCall: ToolCall;
  signal: AbortSignal;
}

export interface ToolExecuteInput extends ToolInput {
  onUpdate?: (update: ToolUpdate) => void;
  detach?: (text: string) => void;
}

export interface ToolHandler {
  execute(input: ToolExecuteInput): Promise<ToolResult>;
}

export interface ToolDefinition extends ToolDescription, ToolHandler {}

export type ToolExecutor = Pick<ToolHandler, 'execute'>;

export interface ToolSchema<Args> {
  readonly jsonSchema: Record<string, unknown>;
  parse(value: unknown): Args | undefined;
}

export interface TypedToolInput<Args> extends ToolExecuteInput {
  args: Args;
}

export interface ExecutorPolicy {
  readonly maxResultChars?: number;
}

export interface RegisterOptions {
  readonly onIdle?: () => void;
}

export interface ToolExecutorHost extends ToolExecutor {
  register(definition: ToolDefinition, options?: RegisterOptions): () => void;
  register(name: string, handler: ToolHandler, options?: RegisterOptions): () => void;
  invalidate(name: string, reason: string): void;
  restore(name: string): void;
}

export function isToolExecutorHost(value: object): value is ToolExecutorHost {
  const record = value as Record<string, unknown>;
  return (
    typeof record['execute'] === 'function' &&
    typeof record['register'] === 'function' &&
    typeof record['invalidate'] === 'function' &&
    typeof record['restore'] === 'function'
  );
}
