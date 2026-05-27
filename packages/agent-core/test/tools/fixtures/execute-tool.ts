import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '../../../src/loop';
import { PathSecurityError } from '../../../src/tools/policies/path-access';

export type TestExecutableToolContext<Input> = ExecutableToolContext & {
  readonly args: Input;
};

export async function executeTool<Input>(
  tool: ExecutableTool<Input>,
  context: TestExecutableToolContext<Input>,
): Promise<ExecutableToolResult> {
  const { args, ...executionContext } = context;
  let execution: ToolExecution;
  try {
    const resolved = tool.resolveExecution(args);
    execution = isPromiseLike(resolved) ? await resolved : resolved;
  } catch (error) {
    const output =
      error instanceof PathSecurityError
        ? error.message
        : `Tool "${tool.name}" failed to resolve execution: ${
            error instanceof Error ? error.message : String(error)
          }`;
    return { isError: true, output };
  }
  if (execution.isError === true) return execution;
  return execution.execute(executionContext);
}

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}
