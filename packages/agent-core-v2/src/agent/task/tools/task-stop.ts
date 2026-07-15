/**
 * TaskStopTool — stop a running task.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import TASK_STOP_DESCRIPTION from './task-stop.md?raw';


export const TaskStopInputSchema = z.object({
  task_id: z.string().describe('The background task ID to stop.'),
  reason: z
    .string()
    .default('Stopped by TaskStop')
    .describe('Short reason recorded when the task is stopped.')
    .optional(),
});

export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;


export class TaskStopTool implements BuiltinTool<TaskStopInput> {
  readonly name = 'TaskStop' as const;
  readonly description = TASK_STOP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskStopInputSchema);

  constructor(@IAgentTaskService private readonly tasks: IAgentTaskService) {}

  resolveExecution(args: TaskStopInput): ToolExecution {
    return {
      description: `Stopping task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: async () => {
        const info = this.tasks.getTask(args.task_id);
        if (!info) {
          return { isError: true, output: `Task not found: ${args.task_id}` };
        }

        const trimmedReason = args.reason?.trim();
        const reason =
          trimmedReason === undefined || trimmedReason.length === 0
            ? 'Stopped by TaskStop'
            : trimmedReason;

        if (TERMINAL_STATUSES.has(info.status)) {
          return {
            output:
              `task_id: ${info.taskId}\n` +
              `status: ${info.status}\n` +
              `reason: ${terminalStopReason(info.stopReason)}`,
            isError: false,
          };
        }

        await this.tasks.suppressTerminalNotification(args.task_id);
        const result = await this.tasks.stop(args.task_id, reason);
        if (!result) {
          return { isError: true, output: `Failed to stop task: ${args.task_id}` };
        }

        return {
          output:
            `task_id: ${result.taskId}\n` +
            `status: ${result.status}\n` +
            `reason: ${result.stopReason ?? reason}`,
          isError: false,
        };
      },
    };
  }
}

registerTool(TaskStopTool);

function terminalStopReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? 'Task already in terminal state' : trimmed;
}
