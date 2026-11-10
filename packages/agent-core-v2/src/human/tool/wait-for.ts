import type { TaskWaitOutcome, ToolResult } from './executor';
import { defineTool, type ToolDefinition } from './tool';
import DESCRIPTION from './wait-for.md?raw';

export const WAIT_FOR_MAX_TIMEOUT_S = 600;

interface WaitForArguments {
  taskId?: string;
  timeoutMs: number;
}

function parseWaitForArguments(
  raw: string | null,
): { args: WaitForArguments; parseError?: undefined } | { args?: undefined; parseError: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { parseError: `invalid WaitFor arguments: ${raw}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { parseError: `invalid WaitFor arguments: ${raw}` };
  }
  const { task_id, timeout } = parsed as { task_id?: unknown; timeout?: unknown };
  if (
    typeof timeout !== 'number' ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > WAIT_FOR_MAX_TIMEOUT_S
  ) {
    return { parseError: `invalid WaitFor arguments: ${raw}` };
  }
  return {
    args: {
      taskId: typeof task_id === 'string' ? task_id : undefined,
      timeoutMs: timeout * 1000,
    },
  };
}

function formatWaitForOutcome(outcome: TaskWaitOutcome, timeoutMs: number): string {
  const lines: string[] = [];
  if (outcome.completed.length === 0 && outcome.running.length === 0) {
    lines.push('no async tool calls running');
  }
  if (outcome.completed.length > 0) {
    lines.push(`completed: ${outcome.completed.join(', ')}`);
  }
  if (outcome.running.length > 0) {
    lines.push(`running: ${outcome.running.join(', ')}`);
  }
  if (outcome.timedOut) {
    lines.push(`timedOut after ${timeoutMs} ms`);
  }
  return lines.join('\n');
}

export const waitForTool: ToolDefinition = defineTool({
  name: 'WaitFor',
  description: DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      timeout: {
        type: 'integer',
        minimum: 1,
        maximum: WAIT_FOR_MAX_TIMEOUT_S,
        description: `Maximum time to wait, in seconds (1-${String(WAIT_FOR_MAX_TIMEOUT_S)}). A timeout is not an error: the tool returns the tasks that are still running, and you can call it again to keep waiting.`,
      },
      task_id: {
        type: 'string',
        description:
          'The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.',
      },
    },
    required: ['timeout'],
  },
  async execute({ toolCall, waitForTasks }): Promise<ToolResult> {
    const parsed = parseWaitForArguments(toolCall.arguments);
    if (parsed.parseError !== undefined) {
      return { content: [{ type: 'text', text: parsed.parseError }], isError: true };
    }
    if (waitForTasks === undefined) {
      return {
        content: [{ type: 'text', text: 'WaitFor requires background task support from the agent' }],
        isError: true,
      };
    }
    const outcome = await waitForTasks({
      taskId: parsed.args.taskId,
      timeoutMs: parsed.args.timeoutMs,
    });
    if (outcome.unknown.length > 0) {
      return {
        content: [{ type: 'text', text: `Task not found: ${outcome.unknown.join(', ')}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: formatWaitForOutcome(outcome, parsed.args.timeoutMs) }] };
  },
});
