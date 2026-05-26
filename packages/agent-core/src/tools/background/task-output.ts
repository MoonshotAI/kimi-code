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
 * `timed_out` when an agent task was aborted by its deadline, and
 * `stop_reason` when the task was explicitly stopped via `TaskStop`.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../agent/tool';
import type { ExecutableToolResult, ToolExecution } from '../../loop/types';
import {
  isBackgroundTaskTerminal,
  type BackgroundProcessManager,
  type BackgroundTaskStatus,
} from './manager';
import { toInputJsonSchema } from '../support/input-schema';
import { matchesGlobRuleSubject } from '../support/rule-match';
import TASK_OUTPUT_DESCRIPTION from './task-output.md';

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

export class TaskOutputTool implements BuiltinTool<TaskOutputInput> {
  readonly name = 'TaskOutput' as const;
  readonly description: string = TASK_OUTPUT_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TaskOutputInputSchema);

  constructor(private readonly manager: BackgroundProcessManager) {}

  resolveExecution(args: TaskOutputInput): ToolExecution {
    return {
      description: `Reading output of task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id),
      execute: () => this.execute(args),
    };
  }

  private async execute(args: TaskOutputInput): Promise<ExecutableToolResult> {
    await this.manager.settlePendingExits();
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
      `retrieval_status: ${retrievalStatus(current.status, args.block)}`,
      `task_id: ${current.taskId}`,
      `status: ${current.status}`,
      `description: ${current.description}`,
      `command: ${current.command}`,
    ];
    if (output.outputPath !== undefined) {
      lines.push(`output_path: ${output.outputPath}`);
    }
    if (current.exitCode !== null) {
      lines.push(`exit_code: ${String(current.exitCode)}`);
    }
    // Surface why a terminal task ended. `terminal_reason` is a categorical
    // label; `timed_out` / `stop_reason` carry the concrete detail.
    //   - timed_out: an agent task aborted by its external deadline.
    //   - stopped:   the task was explicitly cancelled via `TaskStop`
    //                (`stop_reason` is the reason text supplied there).
    // A task that ended on its own (completed / failed / lost) emits none
    // of these so the absence is itself meaningful.
    if (current.timedOut === true) {
      lines.push('timed_out: true', 'terminal_reason: timed_out');
    } else if (current.stopReason !== undefined) {
      lines.push(`stop_reason: ${current.stopReason}`, 'terminal_reason: stopped');
    }
    lines.push(
      `output_size_bytes: ${String(output.outputSizeBytes)}`,
      `output_preview_bytes: ${String(output.previewBytes)}`,
      `output_truncated: ${String(output.truncated)}`,
    );
    // The full, never-truncated log is readable from disk via the `Read`
    // tool whenever it was persisted. Surface that guidance unconditionally
    // — even when the preview already shows everything — so the model knows
    // it can page the complete output. The hint text adapts to whether the
    // preview was truncated. When no full log was persisted, say so instead.
    if (output.fullOutputAvailable && output.outputPath !== undefined) {
      lines.push('full_output_available: true', 'full_output_tool: Read');
      lines.push(
        output.truncated
          ? `full_output_hint: Only the last ${String(OUTPUT_PREVIEW_BYTES)} bytes are shown ` +
              'above. Use the Read tool with the output_path to page through the full log ' +
              `(parameters: path, line_offset, n_lines; read about ${String(PAGING_HINT_LINES)} ` +
              'lines per page).'
          : 'full_output_hint: The preview above is the complete output. Use the Read tool ' +
              'with the output_path if you need to re-read the full log later ' +
              `(parameters: path, line_offset, n_lines; read about ${String(PAGING_HINT_LINES)} ` +
              'lines per page).',
      );
    } else {
      lines.push('full_output_available: false');
    }

    // When the preview omits the head of the log, emit an explicit
    // banner just before the `[output]` marker so the model knows it is
    // looking at a tail, not the full output.
    lines.push('');
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
