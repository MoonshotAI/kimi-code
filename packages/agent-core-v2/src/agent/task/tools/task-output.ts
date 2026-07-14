/**
 * TaskOutputTool — read output from a managed task.
 *
 * Returns structured task metadata plus a fixed-size tail preview of the
 * task's output. The full, never-truncated output lives on disk at
 * `output_path`; the caller is always pointed at the `Read` tool to page
 * through the complete log, and the preview also carries a banner when it
 * has been truncated to a tail.
 *
 * For terminal tasks the output also surfaces why the task ended:
 * `stop_reason` records the concrete reason; `terminal_reason` classifies
 * timeout vs. explicit stop vs. failure for callers that need stable labels.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import type { BuiltinTool, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import type {
  AgentTaskInfo,
  AgentTaskOutputSnapshot,
} from '#/agent/task/task';
import { type AgentTaskStatus, TERMINAL_STATUSES } from '#/agent/task/types';
import { formatPlainObject } from './format';
import TASK_OUTPUT_DESCRIPTION from './task-output.md?raw';

const OUTPUT_PREVIEW_BYTES = 32 * 1024;

const PAGING_HINT_LINES = 300;


export const TaskOutputInputSchema = z.object({
  task_id: z.string().describe('The background task ID to inspect.'),
  block: z
    .boolean()
    .default(false)
    .describe(
      'Whether to wait for the task to finish before returning. Discouraged — background tasks notify automatically on completion; use only when the user explicitly asked you to wait.',
    )
    .optional(),
  timeout: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(30)
    .describe('Maximum number of seconds to wait when block=true.')
    .optional(),
});

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;


function retrievalStatus(
  status: AgentTaskStatus,
  block: boolean | undefined,
): 'success' | 'timeout' | 'not_ready' {
  if (TERMINAL_STATUSES.has(status)) return 'success';
  return block ? 'timeout' : 'not_ready';
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

export class TaskOutputTool implements BuiltinTool<TaskOutputInput> {
  readonly name = 'TaskOutput' as const;
  readonly description: string = TASK_OUTPUT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskOutputInputSchema);

  constructor(@IAgentTaskService private readonly tasks: IAgentTaskService) {}

  resolveExecution(args: TaskOutputInput): ToolExecution {
    return {
      description: `Reading output of task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: ({ signal }) => this.execute(args, signal),
    };
  }

  private async execute(
    args: TaskOutputInput,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    const info = this.tasks.getTask(args.task_id);
    if (!info) {
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    if (args.block && !TERMINAL_STATUSES.has(info.status)) {
      await this.tasks.wait(args.task_id, (args.timeout ?? 30) * 1000, signal);
    }

    const current = this.tasks.getTask(args.task_id);
    if (!current) {
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    const output = await this.tasks.getOutputSnapshot(args.task_id, OUTPUT_PREVIEW_BYTES);

    const lines = [
      formatPlainObject({
        retrievalStatus: retrievalStatus(current.status, args.block),
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
        nextStep:
          args.block === true && !TERMINAL_STATUSES.has(current.status)
            ? 'The task is still running after waiting. Do not block on it again — continue with other work or hand back to the user; you will be notified automatically when it completes.'
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
      message: 'Task snapshot retrieved.',
    };
  }
}

registerTool(TaskOutputTool);
