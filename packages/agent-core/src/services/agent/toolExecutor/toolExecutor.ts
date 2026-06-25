import { createDecorator } from '../../../di';
import type { ToolExecution, ToolUpdate } from '../../../loop';

import type { ToolCall, ToolResult } from '../types';

export interface ToolExecutorOptions {
  readonly signal?: AbortSignal;
  readonly turnId?: string;
  readonly metadata?: unknown;
  readonly onUpdate?: (update: ToolUpdate) => void;
}

export interface IToolExecutor {
  execute(
    call: ToolCall,
    execution: ToolExecution,
    options?: ToolExecutorOptions,
  ): Promise<ToolResult>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IToolExecutor = createDecorator<IToolExecutor>('agentToolExecutorService');
