/**
 * `tools` domain (L7) — `TaskOutputTool` implementation (the `TaskOutput`
 * tool).
 *
 * Returns structured task metadata plus a fixed-size tail preview of the
 * task's output, read through `IAgentTaskService` (`agentTask` domain). The
 * full, never-truncated output lives on disk at `output_path`; the caller is
 * always pointed at the `Read` tool to page through the complete log, and
 * the preview also carries a banner when it has been truncated to a tail.
 *
 * For terminal tasks the output also surfaces why the task ended:
 * `stop_reason` records the concrete reason; `terminal_reason` classifies
 * timeout vs. explicit stop vs. failure for callers that need stable labels.
 * The public contract (input schema, `ITaskOutputTool`) lives in
 * `./task-output`.
 *
 * Registered via the module-level `registerAgentToolService(ITaskOutputTool,
 * TaskOutputTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool. Bound at Agent scope.
 */

import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import { type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import type {
  AgentTaskInfo,
  AgentTaskOutputSnapshot,
} from '#/agent/task/task';
import { type AgentTaskStatus, TERMINAL_STATUSES } from '#/agent/task/types';
import { formatPlainObject } from '#/agent/task/tools/format';
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

    const output = await this.tasks.getOutputSnapshot(args.task_id, OUTPUT_PREVIEW_BYTES);

    const lines = [
      formatPlainObject({
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
