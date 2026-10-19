import type { ContentPart, ToolCall } from '#/llm/message';

export interface ToolUpdate {
  key: string;
  text: string;
  percent?: number;
}

export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
}

export interface ToolDetachAck {
  text: string;
}

export interface TaskWaitInput {
  taskId?: string;
  timeoutMs: number;
}

export interface TaskWaitOutcome {
  completed: string[];
  running: string[];
  unknown: string[];
  timedOut: boolean;
}

export interface ToolExecuteInput {
  toolCall: ToolCall;
  signal: AbortSignal;
  onUpdate?: (update: ToolUpdate) => void;
  detach?: (ack: ToolDetachAck) => void;
  waitForTasks?: (input: TaskWaitInput) => Promise<TaskWaitOutcome>;
}

export interface ToolExecutor {
  execute(input: ToolExecuteInput): Promise<ToolResult>;
}
