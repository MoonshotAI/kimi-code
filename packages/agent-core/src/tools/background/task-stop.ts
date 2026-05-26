/**
 * TaskStopTool — stop a running background task.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import type { ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import { matchesGlobRuleSubject } from '../support/rule-match';
import { isBackgroundTaskTerminal, type BackgroundProcessManager } from './manager';
import TASK_STOP_DESCRIPTION from './task-stop.md';

// ── Input schema ─────────────────────────────────────────────────────

export const TaskStopInputSchema = z.object({
  task_id: z.string().describe('The background task ID to stop.'),
  reason: z
    .string()
    .default('Stopped by TaskStop')
    .describe('Short reason recorded when the task is stopped.')
    .optional(),
});

export type TaskStopInput = z.Infer<typeof TaskStopInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

export class TaskStopTool implements BuiltinTool<TaskStopInput> {
  readonly name = 'TaskStop' as const;
  readonly description = TASK_STOP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskStopInputSchema);

  constructor(private readonly manager: BackgroundProcessManager) {}

  resolveExecution(args: TaskStopInput): ToolExecution {
    return {
      description: `Stopping task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: async () => {
        await this.manager.settlePendingExits();
        const info = this.manager.getTask(args.task_id);
        if (!info) {
          return { isError: true, output: `Task not found: ${args.task_id}` };
        }

        // A blank or whitespace-only reason falls back to the default. `?? default`
        // would not cover the empty-string case, so trim and coalesce explicitly.
        const trimmedReason = args.reason?.trim();
        const reason =
          trimmedReason === undefined || trimmedReason.length === 0
            ? 'Stopped by TaskStop'
            : trimmedReason;

        if (isBackgroundTaskTerminal(info.status)) {
          // Already-terminal tasks report their current state using the same
          // structured multi-line format as the normal stop path below.
          return {
            output:
              `task_id: ${info.taskId}\n` +
              `status: ${info.status}\n` +
              // A task persisted by an older build may carry a blank stopReason;
              // `??` would not coalesce `''`, so trim-and-`||` to the placeholder.
              `reason: ${terminalStopReason(info.stopReason)}`,
            isError: false,
          };
        }

        const result = await this.manager.stop(args.task_id, reason);
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

function terminalStopReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? 'Task already in terminal state' : trimmed;
}
