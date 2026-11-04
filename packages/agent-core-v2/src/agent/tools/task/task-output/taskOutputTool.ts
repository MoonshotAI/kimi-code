import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTaskInfo } from '#/agent/task/task';
import { type AgentTaskStatus, TERMINAL_STATUSES } from '#/agent/task/types';
import { formatTaskRecord } from '#/agent/task/tools/format';
import { ITaskOutputTool, TaskOutputInputSchema, type TaskOutputInput } from './task-output';
import TASK_OUTPUT_DESCRIPTION from './task-output.md?raw';

const OUTPUT_PREVIEW_BYTES = 32 * 1024;

function retrievalStatus(status: AgentTaskStatus): 'success' | 'not_ready' {
  return TERMINAL_STATUSES.has(status) ? 'success' : 'not_ready';
}

function terminalReason(info: AgentTaskInfo): 'timed_out' | 'stopped' | 'failed' | undefined {
  if (info.status === 'timed_out') return 'timed_out';
  if (info.status === 'killed' && info.stopReason !== undefined) return 'stopped';
  if (info.status === 'failed' && info.stopReason !== undefined) return 'failed';
  return undefined;
}

export class TaskOutputTool implements ITaskOutputTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskOutput' as const;
  readonly description: string = TASK_OUTPUT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskOutputInputSchema);

  constructor(@IAgentTaskService private readonly tasks: IAgentTaskService) {}

  resolveExecution(args: TaskOutputInput): ToolExecution {
    return {
      description: `Reading output of task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: TaskOutputInput): Promise<ExecutableToolResult> {
    const current = this.tasks.getTask(args.task_id);
    if (!current) {
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    const output = await this.tasks.getOutputSnapshot(
      args.task_id,
      args.limit ?? OUTPUT_PREVIEW_BYTES,
      args.offset,
    );
    const nextOffset = output.previewOffset + output.previewBytes;

    const lines = [
      formatTaskRecord({
        retrievalStatus: retrievalStatus(current.status),
        ...current,
        outputPath: output.outputPath,
        terminalReason: terminalReason(current),
        outputSizeBytes: output.outputSizeBytes,
        outputOffset: output.previewOffset,
        outputPreviewBytes: output.previewBytes,
        outputTruncated: output.truncated,
        fullOutputAvailable: output.fullOutputAvailable,
        hasMore: output.hasMore,
        nextOffset: output.hasMore ? nextOffset : undefined,
        fullOutputTool: output.fullOutputAvailable ? 'TaskOutput' : undefined,
        fullOutputHint: output.fullOutputAvailable
          ? `Use TaskOutput(task_id=${JSON.stringify(args.task_id)}, offset=N) to read persisted output directly.`
          : undefined,
      }),
      '',
    ];

    if (output.truncated) {
      lines.push(
        output.fullOutputAvailable && output.outputPath !== undefined
          ? `[Truncated. Full output: ${output.outputPath}]`
          : '[Truncated. No persisted full log is available for this task.]',
      );
    }
    lines.push('[output]', output.preview || '[no output available]');

    return {
      output: lines.join('\n'),
      isError: false,
    };
  }
}

registerAgentToolService(ITaskOutputTool, TaskOutputTool, { name: 'TaskOutput', domain: 'agentTask' });
