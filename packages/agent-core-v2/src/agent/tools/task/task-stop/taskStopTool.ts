import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentTaskHistoryService } from '#/agent/task/taskService';
import { agentTaskInfo } from '#/agent/task/handler';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { formatTaskWallTime } from '#/agent/task/wallTime';
import { ITaskStopTool, TaskStopInputSchema, type TaskStopInput } from './task-stop';
import TASK_STOP_DESCRIPTION from './task-stop.md?raw';

export class TaskStopTool implements ITaskStopTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskStop' as const;
  readonly description = TASK_STOP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskStopInputSchema);

  constructor(
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentTaskHistoryService private readonly history: IAgentTaskHistoryService,
  ) {}

  resolveExecution(args: TaskStopInput): ToolExecution {
    return {
      description: `Stopping task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: async () => {
        const handler = this.toolExecutor.handler(args.task_id);
        const info = handler?.snapshot().fields.task === undefined ? this.history.getTask(args.task_id) : agentTaskInfo(handler);
        if (!info) {
          return { isError: true, output: `Task not found: ${args.task_id}` };
        }

        const trimmedReason = args.reason?.trim();
        const reason = trimmedReason === undefined || trimmedReason.length === 0
          ? 'Stopped by TaskStop'
          : trimmedReason;

        if (TERMINAL_STATUSES.has(info.status)) {
          return {
            output:
              `Wall time: ${formatTaskWallTime(info)}\n` +
              `task_id: ${info.taskId}\n` +
              `status: ${info.status}\n` +
              `reason: ${terminalStopReason(info.stopReason)}`,
            isError: false,
          };
        }

        if (handler === undefined) {
          return { isError: true, output: `Failed to stop task: ${args.task_id}` };
        }
        await handler.stop(reason);
        const result = agentTaskInfo(handler);
        return {
          output: [
            `Wall time: ${formatTaskWallTime(result)}`,
            `task_id: ${result.taskId}`,
            `status: ${result.status}`,
            `reason: ${result.stopReason ?? reason}`,
          ].join('\n'),
          isError: false,
        };
      },
    };
  }
}

registerAgentToolService(ITaskStopTool, TaskStopTool, { name: 'TaskStop', domain: 'agentTask' });

function terminalStopReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? 'Task already in terminal state' : trimmed;
}
