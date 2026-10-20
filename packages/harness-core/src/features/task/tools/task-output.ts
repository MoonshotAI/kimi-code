import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import { formatPlainObject } from '../format';
import type { TaskRecord, TaskState } from '../projection';

import TASK_OUTPUT_DESCRIPTION from './task-output.md?raw';

interface TaskIdArgument {
  readonly taskId: string;
}

function parseTaskIdArgument(
  raw: string | null,
  toolName: string,
): { args: TaskIdArgument; parseError?: undefined } | { args?: undefined; parseError: string } {
  let parsed: unknown = {};
  if (raw !== null && raw.trim() !== '') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { parseError: `invalid ${toolName} arguments: ${raw}` };
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { parseError: `invalid ${toolName} arguments: ${raw}` };
  }
  const { task_id } = parsed as { task_id?: unknown };
  if (typeof task_id !== 'string' || task_id === '') {
    return { parseError: `invalid ${toolName} arguments: ${raw}` };
  }
  return { args: { taskId: task_id } };
}

function terminalReason(record: TaskRecord): 'stopped' | 'failed' | undefined {
  if (record.status === 'killed' && record.stopReason !== undefined) return 'stopped';
  if (record.status === 'failed' && record.stopReason !== undefined) return 'failed';
  return undefined;
}

export function formatTaskOutput(record: TaskRecord): string {
  const output = record.output;
  return [
    formatPlainObject({
      retrievalStatus: record.status === 'running' ? 'not_ready' : 'success',
      taskId: record.taskId,
      tool: record.toolName,
      description: record.description,
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      stopReason: record.stopReason,
      terminalReason: terminalReason(record),
      outputSizeBytes: output === undefined ? undefined : Buffer.byteLength(output, 'utf8'),
    }),
    '',
    '[output]',
    output === undefined || output === '' ? '[no output available]' : output,
  ].join('\n');
}

export function createTaskOutputTool(state: { readonly value: TaskState }): ToolDefinition {
  return {
    name: 'TaskOutput',
    description: TASK_OUTPUT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description:
            'The background task ID to inspect — the tool call ID of the tool call that was moved to the background, as shown by TaskList.',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    async execute({ toolCall }): Promise<ToolResult> {
      const parsed = parseTaskIdArgument(toolCall.arguments, 'TaskOutput');
      if (parsed.parseError !== undefined) {
        return { content: [{ type: 'text', text: parsed.parseError }], isError: true };
      }
      const record = state.value.get(parsed.args.taskId);
      if (record === undefined) {
        return {
          content: [{ type: 'text', text: `Task not found: ${parsed.args.taskId}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: formatTaskOutput(record) }] };
    },
  };
}
