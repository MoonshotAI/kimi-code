import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentTaskHistoryService } from '#/agent/task/taskService';
import { IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { agentTaskInfo } from '#/agent/task/handler';
import type {
  AgentTaskInfo,
  AgentTaskOutputSnapshot,
} from '#/agent/task/task';
import { type AgentTaskStatus, TERMINAL_STATUSES } from '#/agent/task/types';
import { formatTaskRecord } from '#/agent/task/tools/format';
import { ITaskOutputTool, TaskOutputInputSchema, type TaskOutputInput } from './task-output';
import TASK_OUTPUT_DESCRIPTION from './task-output.md?raw';

const OUTPUT_PREVIEW_BYTES = 32 * 1024;

const PAGING_HINT_LINES = 300;

function retrievalStatus(status: AgentTaskStatus): 'success' | 'not_ready' {
  return TERMINAL_STATUSES.has(status) ? 'success' : 'not_ready';
}

function terminalReason(info: AgentTaskInfo): 'timed_out' | 'stopped' | 'failed' | undefined {
  if (info.status === 'timed_out') return 'timed_out';
  if (info.status === 'killed' && info.stopReason !== undefined) return 'stopped';
  if (info.status === 'failed' && info.stopReason !== undefined) return 'failed';
  return undefined;
}

function fullOutputHint(output: AgentTaskOutputSnapshot): string | undefined {
  if (!output.fullOutputAvailable || output.outputPath === undefined) return undefined;
  if (output.truncated) {
    return (
      `Only the last ${String(OUTPUT_PREVIEW_BYTES)} bytes are shown above. ` +
      'Use the Read tool with the output_path to page through the full log ' +
      `(parameters: path, line_offset, n_lines; read about ${String(PAGING_HINT_LINES)} ` +
      'lines per page).'
    );
  }
  return (
    'The preview above is the complete output. Use the Read tool with the output_path ' +
    'if you need to re-read the full log later ' +
    `(parameters: path, line_offset, n_lines; read about ${String(PAGING_HINT_LINES)} ` +
    'lines per page).'
  );
}

export class TaskOutputTool implements ITaskOutputTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TaskOutput' as const;
  readonly description: string = TASK_OUTPUT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskOutputInputSchema);

  constructor(
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentTaskHistoryService private readonly history: IAgentTaskHistoryService,
    @IAgentTaskOutputService private readonly taskOutputs: IAgentTaskOutputService,
  ) {}

  resolveExecution(args: TaskOutputInput): ToolExecution {
    return {
      description: `Reading output of task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: TaskOutputInput): Promise<ExecutableToolResult> {
    const handler = this.toolExecutor.handler(args.task_id);
    const current = handler?.snapshot().fields.task === undefined ? this.history.getTask(args.task_id) : agentTaskInfo(handler);
    if (!current) {
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    const live = handler?.output(OUTPUT_PREVIEW_BYTES);
    const persisted = live === undefined
      ? await this.taskOutputs.readTaskOutputSnapshot(args.task_id, OUTPUT_PREVIEW_BYTES)
      : undefined;
    const output: AgentTaskOutputSnapshot = live !== undefined
      ? {
          outputPath: live.path,
          outputSizeBytes: live.totalBytes,
          previewBytes: Buffer.byteLength(live.preview),
          truncated: live.truncated,
          fullOutputAvailable: live.path !== undefined,
          preview: live.preview,
        }
      : persisted === undefined
        ? {
            outputSizeBytes: 0,
            previewBytes: 0,
            truncated: false,
            fullOutputAvailable: false,
            preview: '',
          }
        : { ...persisted, fullOutputAvailable: true };

    const lines = [
      formatTaskRecord({
        retrievalStatus: retrievalStatus(current.status),
        ...current,
        outputPath: output.outputPath,
        terminalReason: terminalReason(current),
        outputSizeBytes: output.outputSizeBytes,
        outputPreviewBytes: output.previewBytes,
        outputTruncated: output.truncated,
        fullOutputAvailable: output.fullOutputAvailable,
        fullOutputTool:
          output.fullOutputAvailable && output.outputPath !== undefined ? 'Read' : undefined,
        fullOutputHint: fullOutputHint(output),
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
