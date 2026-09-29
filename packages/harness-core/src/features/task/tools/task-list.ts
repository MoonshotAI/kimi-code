import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core';

import { formatPlainObject } from '../format';
import type { TaskRecord, TaskState } from '../projection';

import TASK_LIST_DESCRIPTION from './task-list.md?raw';

export const TASK_LIST_DEFAULT_LIMIT = 20;
export const TASK_LIST_MAX_LIMIT = 100;

interface TaskListArguments {
  readonly activeOnly: boolean;
  readonly limit: number;
}

function parseTaskListArguments(
  raw: string | null,
): { args: TaskListArguments; parseError?: undefined } | { args?: undefined; parseError: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { parseError: `invalid TaskList arguments: ${raw}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { parseError: `invalid TaskList arguments: ${raw}` };
  }
  const { active_only, limit } = parsed as { active_only?: unknown; limit?: unknown };
  if (active_only !== undefined && typeof active_only !== 'boolean') {
    return { parseError: `invalid TaskList arguments: ${raw}` };
  }
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > TASK_LIST_MAX_LIMIT)
  ) {
    return { parseError: `invalid TaskList arguments: ${raw}` };
  }
  return {
    args: {
      activeOnly: active_only ?? true,
      limit: limit ?? TASK_LIST_DEFAULT_LIMIT,
    },
  };
}

export function formatTaskRecord(record: TaskRecord): string {
  return formatPlainObject({
    taskId: record.taskId,
    tool: record.toolName,
    description: record.description,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    stopReason: record.stopReason,
  });
}

export function formatTaskList(records: readonly TaskRecord[], activeOnly: boolean): string {
  const label = activeOnly ? 'active_background_tasks' : 'background_tasks';
  const header = `${label}: ${String(records.length)}`;
  if (records.length === 0) return `${header}\nNo background tasks found.`;
  return `${header}\n${records.map((record) => formatTaskRecord(record)).join('\n---\n')}`;
}

export function createTaskListTool(state: { readonly value: TaskState }): ToolDefinition {
  return {
    name: 'TaskList',
    description: TASK_LIST_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        active_only: {
          type: 'boolean',
          description: 'Whether to list only non-terminal background tasks.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: TASK_LIST_MAX_LIMIT,
          description: 'Maximum number of tasks to return.',
        },
      },
      additionalProperties: false,
    },
    async execute({ toolCall }): Promise<ToolResult> {
      const parsed = parseTaskListArguments(toolCall.arguments);
      if (parsed.parseError !== undefined) {
        return { content: [{ type: 'text', text: parsed.parseError }], isError: true };
      }
      const records: TaskRecord[] = [];
      for (const record of state.value.values()) {
        if (parsed.args.activeOnly && record.status !== 'running') continue;
        records.push(record);
        if (records.length >= parsed.args.limit) break;
      }
      return {
        content: [{ type: 'text', text: formatTaskList(records, parsed.args.activeOnly) }],
      };
    },
  };
}
