import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { formatTaskWallTime } from '#/agent/task/wallTime';
import { NO_PARTIAL_OUTPUT, type SubagentTaskInfo } from '#/agent/tools/agent/subagent-task';
import { ITaskStopTool, TaskStopInputSchema, type TaskStopInput } from './task-stop';
import TASK_STOP_DESCRIPTION from './task-stop.md?raw';

const OUTPUT_PREVIEW_BYTES = 32 * 1024;

export class TaskStopTool implements ITaskStopTool {
  declare readonly _serviceBrand: undefined;
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
              `Wall time: ${formatTaskWallTime(info)}\n` +
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

        const lines = [
          `Wall time: ${formatTaskWallTime(result)}`,
          `task_id: ${result.taskId}`,
          `status: ${result.status}`,
          `reason: ${result.stopReason ?? reason}`,
        ];
        if (result.kind === 'agent') {
          lines.push(...(await agentOutputLines(this.tasks, result)));
        }
        return { output: lines.join('\n'), isError: false };
      },
    };
  }
}

registerAgentToolService(ITaskStopTool, TaskStopTool, { name: 'TaskStop', domain: 'agentTask' });

function terminalStopReason(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? 'Task already in terminal state' : trimmed;
}

async function agentOutputLines(
  tasks: IAgentTaskService,
  info: SubagentTaskInfo,
): Promise<string[]> {
  const output = await tasks.getOutputSnapshot(info.taskId, OUTPUT_PREVIEW_BYTES);
  const outputPath =
    output.fullOutputAvailable && output.outputPath !== undefined ? output.outputPath : undefined;
  const lines: string[] = [];
  if (info.agentId !== undefined) lines.push(`agent_id: ${info.agentId}`);
  if (outputPath !== undefined) lines.push(`output_path: ${outputPath}`);
  lines.push('');
  if (output.truncated) {
    lines.push(
      outputPath === undefined
        ? '[Truncated. No persisted full log is available for this task.]'
        : `[Truncated. Full output: ${outputPath}]`,
    );
  }
  lines.push(output.preview.length > 0 ? output.preview : NO_PARTIAL_OUTPUT);
  if (info.agentId !== undefined) {
    lines.push(
      '',
      `resume_hint: To continue this subagent from where it stopped, call Agent(resume="${info.agentId}", prompt="..."). Use agent_id ("${info.agentId}"), not task_id ("${info.taskId}").`,
    );
  }
  return lines;
}
