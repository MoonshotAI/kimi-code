import type { UserMessage } from '#/llm/message';
import type { ToolExecutionHandler, ToolResult } from '#/tool/types';
import type { AsyncToolOutcome } from './contract/outcome';
import type { ToolCompletionFactory } from './tool/outcome';
import type { StepCall } from './turn';

export interface LiveTool extends StepCall {
  readonly turnId: number;
  readonly step: number;
  readonly handler: ToolExecutionHandler;
  detached: boolean;
  announced: boolean;
  responded: boolean;
  done: boolean;
  result?: ToolResult;
  completion?: ToolCompletionFactory;
  completionMessage?: Promise<UserMessage>;
  completionMessageValue?: UserMessage;
  completionOutcome?: AsyncToolOutcome;
  completionPending?: boolean;
  readonly waiters: Set<() => void>;
}
