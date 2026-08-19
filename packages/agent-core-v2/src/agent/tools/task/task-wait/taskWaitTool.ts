import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
  type ToolUpdate,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTaskInfo, AgentTaskOutputSnapshot } from '#/agent/task/task';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { formatPlainObject } from '#/agent/task/tools/format';
import { formatTaskList } from '#/agent/tools/task/task-list/taskListTool';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { abortError, linkAbortSignal } from '#/_base/utils/abort';
import { WAIT_FOR_FLAG_ID } from './flag';
import { IWaitForTool, WaitForInputSchema, type WaitForInput } from './task-wait';
import WAIT_FOR_DESCRIPTION from './task-wait.md?raw';

const OUTPUT_PREVIEW_BYTES = 32 * 1024;

const PAGING_HINT_LINES = 300;

const PROGRESS_INTERVAL_MS = 1_000;

type WaitForOutcome = 'completed' | 'timed_out' | 'task_not_found' | 'aborted';

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

export function waitForProgressUpdate(
  args: WaitForInput,
  runningCount: number,
  startedAt: number,
  now: number,
): ToolUpdate {
  const elapsedS = Math.max(0, Math.round((now - startedAt) / 1000));
  return {
    kind: 'status',
    text:
      `Waiting ${formatWaitSeconds(elapsedS)} / ${formatWaitSeconds(args.timeout)} · ` +
      `${String(runningCount)} background task${runningCount === 1 ? '' : 's'} still running`,
    replace: true,
  };
}

function formatWaitSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0
      ? `${String(minutes)}m`
      : `${String(minutes)}m ${seconds.toString().padStart(2, '0')}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${String(hours)}h`
    : `${String(hours)}h ${remainingMinutes.toString().padStart(2, '0')}m`;
}

export interface WaitForProgressHandle {
  readonly stop: () => void;
  readonly tick: () => void;
}

export function startWaitProgress(
  args: WaitForInput,
  tasks: Pick<IAgentTaskService, 'list'>,
  onUpdate: ((update: ToolUpdate) => void) | undefined,
  startedAt: number,
): WaitForProgressHandle {
  if (onUpdate === undefined) return { stop: () => {}, tick: () => {} };
  const tick = (): void => {
    onUpdate(waitForProgressUpdate(args, tasks.list(true).length, startedAt, Date.now()));
  };
  tick();
  const interval = setInterval(tick, PROGRESS_INTERVAL_MS);
  interval.unref?.();
  return {
    stop: () => {
      clearInterval(interval);
    },
    tick,
  };
}

export class WaitForTool implements IWaitForTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'WaitFor' as const;
  readonly description: string = WAIT_FOR_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(WaitForInputSchema);

  constructor(
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IFlagService private readonly flags: IFlagService,
  ) {}

  resolveExecution(args: WaitForInput): ToolExecution {
    return {
      description:
        args.task_id === undefined
          ? `Waiting up to ${String(args.timeout)}s for any background task`
          : `Waiting up to ${String(args.timeout)}s for task ${args.task_id}`,
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.task_id ?? 'any'),
      execute: (ctx) => this.execute(args, ctx),
    };
  }

  private async execute(
    args: WaitForInput,
    ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    if (!this.flags.enabled(WAIT_FOR_FLAG_ID)) {
      return {
        isError: true,
        output: 'WaitFor is disabled: the wait_for experimental flag is off.',
      };
    }
    const startedAt = Date.now();
    const timeoutMs = args.timeout * 1000;
    const runningAtStart = this.tasks.list(true);

    if (args.task_id === undefined) {
      if (runningAtStart.length === 0) {
        this.track(args, startedAt, timeoutMs, 'completed', 0);
        return {
          output: [
            formatPlainObject({ waitStatus: 'no_tasks', waitedMs: 0, timeoutMs }),
            'No background tasks are running, so there is nothing to wait for. Finished tasks report back via automatic notification.',
          ].join('\n\n'),
          isError: false,
        };
      }
    } else if (this.tasks.getTask(args.task_id) === undefined) {
      this.track(args, startedAt, timeoutMs, 'task_not_found', 0);
      return { isError: true, output: `Task not found: ${args.task_id}` };
    }

    let waited: AgentTaskInfo | undefined;
    const progress = startWaitProgress(args, this.tasks, ctx.onUpdate, startedAt);
    try {
      waited =
        args.task_id === undefined
          ? await this.waitAny(runningAtStart, timeoutMs, ctx.signal)
          : await this.tasks.wait(args.task_id, timeoutMs, ctx.signal);
    } catch (error) {
      this.track(args, startedAt, timeoutMs, 'aborted', 0);
      throw error;
    } finally {
      progress.stop();
    }

    if (waited === undefined) {
      this.track(args, startedAt, timeoutMs, 'task_not_found', 0);
      return { isError: true, output: `Task not found: ${args.task_id ?? ''}` };
    }

    if (!TERMINAL_STATUSES.has(waited.status)) {
      this.track(args, startedAt, timeoutMs, 'timed_out', 0);
      return { output: this.formatTimeout(args, startedAt, timeoutMs), isError: false };
    }

    const extras = this.collectExtras(runningAtStart, waited.taskId);
    const output = await this.formatCompleted(waited, extras, startedAt, timeoutMs);
    this.tasks.markTasksDeliveredViaWait(
      [waited, ...extras].map((info) => ({ taskId: info.taskId, status: info.status })),
    );
    this.track(args, startedAt, timeoutMs, 'completed', extras.length);
    return { output, isError: false };
  }

  private async waitAny(
    running: readonly AgentTaskInfo[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<AgentTaskInfo | undefined> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    try {
      const outcomes = running.map((task) =>
        this.tasks.wait(task.taskId, timeoutMs, controller.signal).then(
          (info) => ({ info, error: undefined }),
          (error: unknown) => ({
            info: undefined,
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        ),
      );
      const first = await Promise.race(outcomes);
      if (first.error !== undefined) throw first.error;
      return first.info;
    } finally {
      unlink();
      controller.abort(abortError());
    }
  }

  private collectExtras(
    runningAtStart: readonly AgentTaskInfo[],
    finishedTaskId: string,
  ): AgentTaskInfo[] {
    const extras: AgentTaskInfo[] = [];
    for (const task of runningAtStart) {
      if (task.taskId === finishedTaskId) continue;
      const current = this.tasks.getTask(task.taskId);
      if (current !== undefined && TERMINAL_STATUSES.has(current.status)) extras.push(current);
    }
    return extras;
  }

  private formatTimeout(args: WaitForInput, startedAt: number, timeoutMs: number): string {
    const lines = [
      formatPlainObject({
        waitStatus: 'timed_out',
        taskId: args.task_id,
        waitedMs: Date.now() - startedAt,
        timeoutMs,
      }),
      'The wait ended before the task finished — a timeout is not an error. Call WaitFor again to keep waiting, or continue with other work; completion also arrives via automatic notification.',
    ];
    const running = this.tasks.list(true);
    if (running.length > 0) {
      lines.push('', '[still_running]', formatTaskList(running, true));
    }
    return lines.join('\n');
  }

  private async formatCompleted(
    finished: AgentTaskInfo,
    extras: readonly AgentTaskInfo[],
    startedAt: number,
    timeoutMs: number,
  ): Promise<string> {
    const lines = [
      formatPlainObject({
        waitStatus: 'completed',
        taskId: finished.taskId,
        waitedMs: Date.now() - startedAt,
        timeoutMs,
      }),
      '',
      '[finished]',
      ...(await this.formatFinishedTask(finished)),
    ];
    if (extras.length > 0) {
      lines.push(
        '',
        '[completed_during_wait]',
        extras.map((extra) => formatPlainObject(extra)).join('\n---\n'),
        'Use TaskOutput with one of the task_id values above to read the full output.',
      );
    }
    const running = this.tasks.list(true);
    if (running.length > 0) {
      lines.push('', '[still_running]', formatTaskList(running, true));
    }
    return lines.join('\n');
  }

  private async formatFinishedTask(info: AgentTaskInfo): Promise<string[]> {
    const output = await this.tasks.getOutputSnapshot(info.taskId, OUTPUT_PREVIEW_BYTES);
    const lines = [
      formatPlainObject({
        ...info,
        outputPath: output.outputPath,
        terminalReason: terminalReason(info),
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
    return lines;
  }

  private track(
    args: WaitForInput,
    startedAt: number,
    timeoutMs: number,
    outcome: WaitForOutcome,
    extraCompletedCount: number,
  ): void {
    this.telemetry.track2('wait_for_completed', {
      outcome,
      timeout_ms: timeoutMs,
      waited_ms: Date.now() - startedAt,
      has_task_id: args.task_id !== undefined,
      extra_completed_count: extraCompletedCount,
    });
  }
}

registerAgentToolService(IWaitForTool, WaitForTool, {
  name: 'WaitFor',
  domain: 'agentTask',
  when: (accessor) => accessor.get(IFlagService).enabled(WAIT_FOR_FLAG_ID),
});
