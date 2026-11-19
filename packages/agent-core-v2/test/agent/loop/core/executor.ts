import type { LoopToolContext, LoopToolExecutor } from '@moonshot-ai/core/loop/create-loop';
import {
  textToolContent,
  ToolExecutor,
  type ToolExecuteContext,
  type ToolExecutorHook,
  type ToolReturn,
} from '#/tool/executor';

export function executorFrom(
  names: readonly string[],
  execute: (context: ToolExecuteContext<unknown, LoopToolContext>) => Promise<ToolReturn>,
  hook?: ToolExecutorHook<LoopToolContext>,
): LoopToolExecutor {
  return new ToolExecutor<LoopToolContext>(names.map((name) => ({
    name,
    description: name,
    parameters: { type: 'object', additionalProperties: true },
    execute,
  })), { hook });
}

export function successfulExecutor(names: readonly string[], text = 'ok'): LoopToolExecutor {
  return executorFrom(names, async () => ({ content: textToolContent(text) }));
}
