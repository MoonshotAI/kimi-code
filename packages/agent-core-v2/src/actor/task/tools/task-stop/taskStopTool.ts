import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { AgentTask, type TaskRuntime } from '#/actor/task/taskAgentRuntime';
import { TERMINAL_STATUSES } from '#/actor/task/types';
import { type ITaskStopTool, TaskStopInputSchema, type TaskStopInput } from './task-stop';
import TASK_STOP_DESCRIPTION from './task-stop.md?raw';

export class TaskStopTool implements ITaskStopTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskStop' as const;
  readonly description = TASK_STOP_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskStopInputSchema);

  constructor(private readonly tasks: TaskRuntime) {}

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

registerAgentToolService({
  name: 'TaskStop',
  domain: 'agentTask',
  create: (context) =>
    new TaskStopTool(context.get(IAgentLifecycleService).resolve(context.agent, AgentTask)),
});

function terminalStopReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? 'Task already in terminal state' : trimmed;
}
