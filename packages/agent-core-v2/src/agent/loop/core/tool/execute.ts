import {
  isToolResult,
  toolExecutionFailureOf,
  type ToolExecuteInput,
  type ToolExecutor,
  type ToolResult,
} from '#human/tool/executor';

export type ToolExecOutput =
  | { type: 'succeeded'; result: ToolResult }
  | { type: 'failed'; error: unknown; result?: ToolResult }
  | { type: 'aborted'; reason?: unknown };

export function executeLoopTool(executor: ToolExecutor, input: ToolExecuteInput): Promise<ToolExecOutput> {
  return Promise.resolve()
    .then(() => executor.execute(input))
    .then(
      (result: unknown): ToolExecOutput =>
        isToolResult(result)
          ? { type: 'succeeded', result }
          : { type: 'failed', error: new Error('invalid tool result') },
      (error: unknown): ToolExecOutput => {
        const failure = toolExecutionFailureOf(error);
        return input.signal.aborted
          ? { type: 'aborted', reason: input.signal.reason }
          : { type: 'failed', error: failure?.error ?? error, result: failure?.result };
      },
    );
}
