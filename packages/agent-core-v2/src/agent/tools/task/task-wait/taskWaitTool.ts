import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
  type ToolUpdate,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService, type AgentToolExecutionHandler } from '#/agent/toolExecutor/toolExecutor';
import { IAgentTaskHistoryService } from '#/agent/task/taskService';
import { agentTaskInfo } from '#/agent/task/handler';
import { ToolTimeoutError } from '#/tool/executor';
import type { AgentTaskInfo } from '#/agent/task/task';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { formatPlainObject, formatTaskRecord } from '#/agent/task/tools/format';
import { formatTaskList } from '#/agent/tools/task/task-list/taskListTool';
import { IFlagService } from '#/app/flag/flag';
import { IAgentGoalService } from '#/features/goal/goalService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { abortError, isAbortError, linkAbortSignal } from '#/_base/utils/abort';
import { WAIT_FOR_FLAG_ID } from './flag';
import { IWaitForTool, WaitForInputSchema, type WaitForInput } from './task-wait';
import WAIT_FOR_DESCRIPTION from './task-wait.md?raw';

const PROGRESS_INTERVAL_MS = 1_000;

type WaitForOutcome = 'completed' | 'timed_out' | 'task_not_found' | 'aborted' | 'interrupted';

interface TurnWaitTally {
  readonly turnId: number;
  calls: number;
  waitedMs: number;
}

function terminalReason(info: AgentTaskInfo): 'timed_out' | 'stopped' | 'failed' | undefined {
  if (info.status === 'timed_out') return 'timed_out';
  if (info.status === 'killed' && info.stopReason !== undefined) return 'stopped';
  if (info.status === 'failed' && info.stopReason !== undefined) return 'failed';
  return undefined;
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
    fields: {
      wait: {
        elapsedS,
        timeoutS: args.timeout,
        runningCount,
      },
    },
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
  tasks: { list(activeOnly?: boolean): readonly AgentTaskInfo[] },
  onUpdate: ((update: ToolUpdate) => void) | undefined,
  startedAt: number,
): WaitForProgressHandle {
  if (onUpdate === undefined) return { stop: () => {}, tick: () => {} };
  const tick = (): void => {
    onUpdate(waitForProgressUpdate(args, tasks.list(true).length, startedAt, Date.now()));
  };
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

  private readonly isSubagent: boolean;
  private tally: TurnWaitTally | undefined;

  constructor(
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentTaskHistoryService private readonly history: IAgentTaskHistoryService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentGoalService private readonly goals: IAgentGoalService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.isSubagent = scopeContext.agentId !== MAIN_AGENT_ID;
  }

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
    const tally = this.countCall(ctx.turnId);
    const startedAt = Date.now();
    const timeoutMs = args.timeout * 1000;
    const runningAtStart = this.toolExecutor.handlers().filter((handler) => {
      if (handler.snapshot().fields.task === undefined) return false;
      const status = handler.snapshot().status;
      return status === 'running' || status === 'stopping';
    });

    if (args.task_id === undefined) {
      if (runningAtStart.length === 0) {
        this.track(args, startedAt, timeoutMs, 'completed', 0);
        return {
          output: this.withRepeatWarning(
            [
              formatPlainObject({ waitStatus: 'no_tasks', waitedMs: 0, timeoutMs }),
              'No background tasks are running, so there is nothing to wait for. Finished tasks report back via automatic notification.',
            ].join('\n\n'),
            tally,
          ),
          isError: false,
        };
      }
    } else if (this.getTask(args.task_id) === undefined) {
      this.track(args, startedAt, timeoutMs, 'task_not_found', 0);
      return { isError: true, output: this.withRepeatWarning(`Task not found: ${args.task_id}`, tally) };
    }

    let waited: AgentTaskInfo | undefined;
    const signal = ctx.steerSignal === undefined
      ? ctx.signal
      : AbortSignal.any([ctx.signal, ctx.steerSignal]);
    const progress = startWaitProgress(args, { list: () => this.listTasks() }, ctx.onUpdate, startedAt);
    try {
      waited =
        args.task_id === undefined
          ? await this.waitAny(runningAtStart, timeoutMs, signal)
          : await this.waitTask(args.task_id, timeoutMs, signal);
    } catch (error) {
      if (
        !ctx.signal.aborted && ctx.steerSignal?.aborted &&
        (error === ctx.steerSignal.reason || isAbortError(error))
      ) {
        this.track(args, startedAt, timeoutMs, 'interrupted', 0);
        tally.waitedMs += Date.now() - startedAt;
        return {
          output: this.withRepeatWarning(this.formatInterrupted(args, startedAt, timeoutMs), tally),
          isError: false,
        };
      }
      this.track(args, startedAt, timeoutMs, 'aborted', 0);
      throw error;
    } finally {
      progress.stop();
    }
    tally.waitedMs += Date.now() - startedAt;

    if (waited === undefined) {
      this.track(args, startedAt, timeoutMs, 'task_not_found', 0);
      return { isError: true, output: this.withRepeatWarning(`Task not found: ${args.task_id ?? ''}`, tally) };
    }

    if (!TERMINAL_STATUSES.has(waited.status)) {
      this.track(args, startedAt, timeoutMs, 'timed_out', 0);
      return {
        output: this.withRepeatWarning(this.formatTimeout(args, startedAt, timeoutMs), tally),
        isError: false,
      };
    }

    const extras = this.collectExtras(runningAtStart, waited.taskId);
    const output = this.formatCompleted(waited, extras, startedAt, timeoutMs);
    this.track(args, startedAt, timeoutMs, 'completed', extras.length);
    return { output: this.withRepeatWarning(output, tally), isError: false };
  }

  private countCall(turnId: number): TurnWaitTally {
    if (this.tally?.turnId !== turnId) {
      this.tally = { turnId, calls: 0, waitedMs: 0 };
    }
    this.tally.calls += 1;
    return this.tally;
  }

  private withRepeatWarning(output: string, tally: TurnWaitTally): string {
    if (tally.calls < 2) return output;
    const waited = formatWaitSeconds(Math.round(tally.waitedMs / 1000));
    const summary = `This is WaitFor call ${String(tally.calls)} in this turn, and you have already spent ${waited} waiting.`;
    return [output, '', '[wait_warning]', `${summary} ${this.repeatWaitAdvice()}`].join('\n');
  }

  private repeatWaitAdvice(): string {
    if (this.isSubagent) {
      return "Stop waiting by reflex: repeated waits burn time your caller is waiting on. Before calling WaitFor again, do every part of your task that does not depend on the running background task. Wait again only for a result you truly cannot finish without — ending your turn is your final hand-off, so do not hand off without it, but never wait for tasks you do not need.";
    }
    if (this.goals.getGoal().goal?.status === 'active') {
      return 'Stop waiting by reflex: repeated waits stall the goal. Before calling WaitFor again, do every piece of remaining goal work that does not depend on the running background task — there is almost always some. Wait again only if nothing else can proceed until it finishes; even then, WaitFor beats polling with Bash sleep or ending the turn only to be continued again.';
    }
    return 'Stop calling WaitFor. Repeated waiting wastes the user\'s time and is almost never the right move. Do not call it again in this turn unless the user explicitly asked you to wait. Do something useful now — another part of the task, or verifying earlier work — or end your turn with a progress update. Finished background tasks notify you automatically, so you will not miss the result.';
  }

  private listTasks(): AgentTaskInfo[] {
    return this.toolExecutor.handlers().flatMap((handler) => {
      if (handler.snapshot().fields.task === undefined) return [];
      const status = handler.snapshot().status;
      return status === 'running' || status === 'stopping' ? [agentTaskInfo(handler)] : [];
    });
  }

  private getTask(taskId: string): AgentTaskInfo | undefined {
    const handler = this.toolExecutor.handler(taskId);
    return handler?.snapshot().fields.task === undefined ? this.history.getTask(taskId) : agentTaskInfo(handler);
  }

  private async waitTask(
    taskId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<AgentTaskInfo | undefined> {
    const handler = this.toolExecutor.handler(taskId);
    if (handler === undefined) return this.history.getTask(taskId);
    try {
      await handler.wait(timeoutMs, signal);
    } catch (error) {
      if (!(error instanceof ToolTimeoutError)) throw error;
    }
    return handler.snapshot().fields.task === undefined ? this.history.getTask(taskId) : agentTaskInfo(handler);
  }

  private async waitAny(
    running: readonly AgentToolExecutionHandler[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<AgentTaskInfo | undefined> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    try {
      const outcomes = running.map((handler) =>
        this.waitTask(handler.taskId, timeoutMs, controller.signal).then(
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
    runningAtStart: readonly AgentToolExecutionHandler[],
    finishedTaskId: string,
  ): AgentTaskInfo[] {
    const extras: AgentTaskInfo[] = [];
    for (const handler of runningAtStart) {
      if (handler.taskId === finishedTaskId) continue;
      const current = this.getTask(handler.taskId);
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
      this.isSubagent
        ? 'The wait ended before the task finished — a timeout is not an error. If you need its result, call WaitFor again: ending your turn is your hand-off, and a completion notification after it reaches no one.'
        : 'The wait ended before the task finished — a timeout is not an error. Prefer continuing with other work over waiting again; completion arrives via automatic notification.',
    ];
    const running = this.listTasks();
    if (running.length > 0) {
      lines.push('', '[still_running]', formatTaskList(running, true));
    }
    return lines.join('\n');
  }

  private formatInterrupted(args: WaitForInput, startedAt: number, timeoutMs: number): string {
    const lines = [
      formatPlainObject({
        waitStatus: 'interrupted',
        reason: 'steer',
        taskId: args.task_id,
        waitedMs: Date.now() - startedAt,
        timeoutMs,
      }),
      'New input ended this wait early. Read the new input before deciding what to do next. Background tasks have not been stopped; completion still arrives via automatic notification.',
    ];
    const running = this.listTasks();
    if (running.length > 0) {
      lines.push('', '[still_running]', formatTaskList(running, true));
    }
    return lines.join('\n');
  }

  private formatCompleted(
    finished: AgentTaskInfo,
    extras: readonly AgentTaskInfo[],
    startedAt: number,
    timeoutMs: number,
  ): string {
    const lines = [
      formatPlainObject({
        waitStatus: 'completed',
        taskId: finished.taskId,
        waitedMs: Date.now() - startedAt,
        timeoutMs,
      }),
      '',
      '[finished]',
      formatTaskRecord({ ...finished, terminalReason: terminalReason(finished) }),
    ];
    if (extras.length > 0) {
      lines.push(
        '',
        '[completed_during_wait]',
        extras.map((extra) => formatTaskRecord(extra)).join('\n---\n'),
        'Use TaskOutput with one of the task_id values above to read the full output.',
      );
    }
    const running = this.listTasks();
    if (running.length > 0) {
      lines.push('', '[still_running]', formatTaskList(running, true));
    }
    return lines.join('\n');
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
