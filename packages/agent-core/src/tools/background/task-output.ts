/**
 * TaskOutputTool — read output from a background task.
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

import type { BuiltinTool } from '../../agent/tool';
import {
  type BackgroundManager,
  isBackgroundTaskTerminal,
  type BackgroundTaskInfo,
  type BackgroundTaskOutputSnapshot,
  type BackgroundTaskStatus,
} from '../../agent/background';
import type { ExecutableToolResult, ToolExecution } from '../../loop/types';
import { toInputJsonSchema } from '../support/input-schema';
import { matchesGlobRuleSubject } from '../support/rule-match';
import { formatPlainObject } from './format';
import TASK_OUTPUT_DESCRIPTION from './task-output.md?raw';

/**
 * Maximum bytes of output included inline as a preview. Output larger
 * than this is truncated to its tail; the full log is read separately
 * via the `Read` tool with the returned `output_path`.
 */
const OUTPUT_PREVIEW_BYTES = 32 * 1024; // 32 KiB

/** Number of lines the paging hint suggests reading per `Read` call. */
const PAGING_HINT_LINES = 300;

// ── Input schema ─────────────────────────────────────────────────────

export const TaskOutputInputSchema = z.object({
  task_id: z.string().describe('The background task ID to inspect.'),
  block: z
    .boolean()
    .default(false)
    .describe('Whether to wait for the task to finish before returning.')
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

export type TaskOutputInput = z.Infer<typeof TaskOutputInputSchema>;

// ── Implementation ───────────────────────────────────────────────────

function retrievalStatus(
  status: BackgroundTaskStatus,
  block: boolean | undefined,
): 'success' | 'timeout' | 'not_ready' {
  if (isBackgroundTaskTerminal(status)) return 'success';
  return block ? 'timeout' : 'not_ready';
}

function terminalReason(info: BackgroundTaskInfo): 'timed_out' | 'stopped' | 'failed' | undefined {
  if (info.status === 'timed_out') return 'timed_out';
  if (info.status === 'killed' && info.stopReason !== undefined) return 'stopped';
  if (info.status === 'failed' && info.stopReason !== undefined) return 'failed';
  return undefined;
}

function fullOutputHint(output: BackgroundTaskOutputSnapshot): string | undefined {
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

  constructor(private readonly manager: BackgroundManager) {}

  resolveExecution(args: TaskOutputInput): ToolExecution {
    return {
      description: `Reading output of task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: TaskOutputInput): Promise<ExecutableToolResult> {
    const info = this.manager.getTask(args.task_id);
    if (!info) {
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    if (args.block && !isBackgroundTaskTerminal(info.status)) {
      await this.manager.wait(args.task_id, (args.timeout ?? 30) * 1000);
    }

    // Re-fetch after potential wait.
    const current = this.manager.getTask(args.task_id);
    if (!current) {
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    // A single manager-owned snapshot drives the tail window and every
    // reported metric below. Persisted logs remain authoritative when
    // available; detached managers fall back to their live ring buffer.
    const output = await this.manager.getOutputSnapshot(args.task_id, OUTPUT_PREVIEW_BYTES);

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
      }),
      '',
    ];

    // When the preview omits the head of the log, emit an explicit
    // banner just before the `[output]` marker so the model knows it is
    // looking at a tail, not the full output.
    if (output.truncated) {
      lines.push(
        output.fullOutputAvailable && output.outputPath !== undefined
          ? `[Truncated. Full output: ${output.outputPath}]`
          : '[Truncated. No persisted full log is available for this task.]',
      );
    }
    lines.push('[output]', output.preview || '[no output available]');

    // Side-channel brief for the host UI / log readers. Distinct from
    // the `output` body which is parsed by the LLM. Kept short so log
    // readers can render it as a one-liner.
    return {
      output: lines.join('\n'),
      isError: false,
      message: 'Task snapshot retrieved.',
    };
  }

}
