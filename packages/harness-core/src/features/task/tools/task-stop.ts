import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core';

import type { TaskRecord, TaskState } from '../projection';

import TASK_STOP_DESCRIPTION from './task-stop.md?raw';

export const TASK_STOP_DEFAULT_REASON = 'Stopped by TaskStop';
export const TASK_ALREADY_TERMINAL_REASON = 'Task already in terminal state';

interface TaskStopArguments {
  readonly taskId: string;
  readonly reason?: string;
}

function parseTaskStopArguments(
  raw: string | null,
): { args: TaskStopArguments; parseError?: undefined } | { args?: undefined; parseError: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { parseError: `invalid TaskStop arguments: ${raw}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { parseError: `invalid TaskStop arguments: ${raw}` };
  }
  const { task_id, reason } = parsed as { task_id?: unknown; reason?: unknown };
  if (typeof task_id !== 'string' || task_id === '') {
    return { parseError: `invalid TaskStop arguments: ${raw}` };
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return { parseError: `invalid TaskStop arguments: ${raw}` };
  }
  return { args: { taskId: task_id, reason } };
}

export function createTaskStopTool(
  state: { readonly value: TaskState },
  stop: (taskId: string, reason: string) => Promise<TaskRecord | undefined>,
): ToolDefinition {
  return {
    name: 'TaskStop',
    description: TASK_STOP_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description:
            'The background task ID to stop — the tool call ID of the tool call that was moved to the background, as shown by TaskList.',
        },
        reason: {
          type: 'string',
          description: 'Short reason recorded when the task is stopped.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    async execute({ toolCall }): Promise<ToolResult> {
      const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
      const errorText = (value: string): ToolResult => ({
        content: [{ type: 'text', text: value }],
        isError: true,
      });
      const parsed = parseTaskStopArguments(toolCall.arguments);
      if (parsed.parseError !== undefined) return errorText(parsed.parseError);
      const { taskId, reason } = parsed.args;
      const record = state.value.get(taskId);
      if (record === undefined) return errorText(`Task not found: ${taskId}`);
      const trimmed = reason?.trim();
      const stopReason =
        trimmed === undefined || trimmed.length === 0 ? TASK_STOP_DEFAULT_REASON : trimmed;
      if (record.status !== 'running') {
        const recorded = record.stopReason?.trim();
        return text(
          `task_id: ${record.taskId}\n` +
            `status: ${record.status}\n` +
            `reason: ${recorded === undefined || recorded.length === 0 ? TASK_ALREADY_TERMINAL_REASON : record.stopReason}`,
        );
      }
      const stopped = await stop(taskId, stopReason);
      if (stopped === undefined) return errorText(`Task not found: ${taskId}`);
      return text(
        `task_id: ${stopped.taskId}\n` +
          `status: ${stopped.status}\n` +
          `reason: ${stopped.stopReason ?? stopReason}`,
      );
    },
  };
}
