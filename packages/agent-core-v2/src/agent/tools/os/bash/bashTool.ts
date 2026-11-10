import type { Readable } from 'node:stream';

import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { resolveAgentTaskConfig } from '#/agent/task/configSection';
import { IConfigService } from '#/app/config/config';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { acquireOrWhenReady, pinnedGeneration, IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import {
  type ToolOutputAccumulatorResult,
  ToolOutputAccumulator,
} from '#/tool/output-accumulator';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { isAbortError, userCancellationReason } from '#/_base/utils/abort';
import bashDescriptionTemplate from './bash.md?raw';
import {
  type BashInput,
  BashInputSchema,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  DEFAULT_TIMEOUT_S,
  IBashTool,
  MAX_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
} from './bash';

const MS_PER_SECOND = 1000;

const BACKGROUND_GUIDANCE =
  'For long-running builds, tests, watchers, or servers that the conversation should not wait on, set `run_in_background=true` with a short `description`; the call returns a task ID. Set `disable_timeout=true` only when the task should run without a timeout. You are notified automatically when the task completes, so return control to the user instead of waiting on it. Use `TaskOutput` only for a non-blocking snapshot, and `TaskStop` only to cancel.';

const NO_BACKGROUND_GUIDANCE =
  'Background execution is disabled for this agent. Do not set `run_in_background=true`.';

const TIMEOUT_MOVES_TO_BACKGROUND =
  'Set `timeout` for possibly long-running commands. A foreground command that hits its timeout is moved to the background instead of being killed, and you are notified when it completes. The user can also move a running foreground command to the background at any time.';

const TIMEOUT_KILLS_WITH_BACKGROUND =
  'Set `timeout` for possibly long-running commands. A foreground command that hits its timeout is killed. The user can also move a running foreground command to the background at any time.';

const TIMEOUT_KILLS = 'Set `timeout` for possibly long-running commands. A command that hits its timeout is killed.';

function timeoutCapS(isBackground: boolean): number {
  return isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
}

function normalizeTimeoutMs(timeout: number | undefined, isBackground: boolean): number {
  const defaultSeconds = isBackground ? DEFAULT_BACKGROUND_TIMEOUT_S : DEFAULT_TIMEOUT_S;
  const value = timeout ?? defaultSeconds;
  return Math.min(value, timeoutCapS(isBackground)) * MS_PER_SECOND;
}

async function disposeProcess(proc: IHostProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
  }
}

export class BashTool implements IBashTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Bash' as const;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BashInputSchema);

  constructor(
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentTaskOutputService private readonly taskOutputs: IAgentTaskOutputService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IConfigService private readonly config: IConfigService,
  ) {}

  private allowBackground(): boolean {
    return (
      this.toolPolicy.isToolActive('TaskList') &&
      this.toolPolicy.isToolActive('TaskOutput') &&
      this.toolPolicy.isToolActive('TaskStop')
    );
  }

  private autoBackgroundOnTimeout(): boolean {
    return resolveAgentTaskConfig(this.config)?.bashAutoBackgroundOnTimeout ?? true;
  }

  private detachTimeoutMs(): number {
    const configuredS = resolveAgentTaskConfig(this.config)?.bashTaskTimeoutS;
    if (configuredS === undefined) return DEFAULT_BACKGROUND_TIMEOUT_S * MS_PER_SECOND;
    return configuredS * MS_PER_SECOND;
  }

  get description(): string {
    const allowBackground = this.allowBackground();
    return renderPrompt(bashDescriptionTemplate, {
      SHELL_NAME: this.environment.inspect().host?.shellName ?? 'sh',
      TIMEOUT_GUIDANCE: !allowBackground
        ? TIMEOUT_KILLS
        : this.autoBackgroundOnTimeout()
          ? TIMEOUT_MOVES_TO_BACKGROUND
          : TIMEOUT_KILLS_WITH_BACKGROUND,
      BACKGROUND_GUIDANCE: allowBackground ? BACKGROUND_GUIDANCE : NO_BACKGROUND_GUIDANCE,
    });
  }

  resolveExecution(args: BashInput): ToolExecution {
    const expectedGeneration = this.reviewedGeneration();
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    let stop = ({ abandon }: {
      readonly reason: unknown;
      readonly abandon: (result?: ExecutableToolResult) => void;
    }): void => {
      abandon({ isError: true, output: 'Aborted before command started' });
    };
    return {
      description: args.run_in_background
        ? `Starting background: ${preview}`
        : `Running: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: this.executionCwd(args),
        description: args.description,
        language: 'bash',
      },
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      stopping: (context) => stop?.(context),
      execute: (ctx) => this.execution(args, ctx, expectedGeneration, (next) => {
        stop = next;
      }),
    };
  }

  private reviewedGeneration(): string | undefined {
    try {
      return pinnedGeneration(this.environment.inspect());
    } catch {
      return undefined;
    }
  }

  private executionCwd(args: BashInput): string {
    try {
      const view = new EnvironmentWorkspaceView(this.environment.inspect(), this.workspaceCtx);
      return view.resolve(args.cwd ?? view.workDir);
    } catch {
      return args.cwd ?? this.ctx.cwd;
    }
  }

  private spawn(
    processService: IHostProcessService,
    view: EnvironmentWorkspaceView,
    cwd: string | undefined,
    command: string,
  ): Promise<IHostProcess> {
    const env = view.host;
    const effectiveCwd = view.resolve(cwd ?? view.workDir);
    const shellCwd = view.shellPathBridge?.toShellPath(effectiveCwd) ?? effectiveCwd;
    const shellCommand = `cd ${shellQuote(shellCwd)} && ${command}`;
    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
      SHELL: env.shellPath,
    };

    return processService.spawn(env.shellPath, ['-c', shellCommand], { cwd: effectiveCwd, env: noninteractiveEnv });
  }

  private async execution(
    args: BashInput,
    ctx: ExecutableToolContext,
    expectedGeneration: string | undefined,
    setStop: (stop: (context: {
      readonly reason: unknown;
      readonly abandon: (result?: ExecutableToolResult) => void;
    }) => void) => void,
  ): Promise<ExecutableToolResult> {
    const { signal, toolCallId, onForegroundTaskStart, taskId = toolCallId, write, set, detach, onDetach } = ctx;
    const validationError = this.validateRunRequest(args, signal);
    if (validationError !== undefined) return validationError;

    const startsInBackground = args.run_in_background === true;
    const foregroundTimeoutMs = normalizeTimeoutMs(args.timeout, false);
    const lease = await acquireOrWhenReady(this.environment, ['process']);
    if (expectedGeneration !== undefined && lease.environment.identity.generation !== expectedGeneration) {
      lease.dispose();
      return { isError: true, output: 'Environment changed before execution. Retry the tool call.' };
    }
    const view = new EnvironmentWorkspaceView(lease.environment, this.workspaceCtx);
    const command = view.host.osKind === 'Windows' ? rewriteWindowsNullRedirect(args.command) : args.command;
    const description = startsInBackground ? args.description!.trim() : foregroundDescription(args);
    const timeoutMs = startsInBackground
      ? args.disable_timeout
        ? undefined
        : args.timeout === undefined
          ? this.detachTimeoutMs()
          : normalizeTimeoutMs(args.timeout, true)
      : foregroundTimeoutMs;
    const builder = new ToolOutputAccumulator();
    let proc: IHostProcess;
    try {
      proc = lease.track(await this.spawn(lease.environment.process!, view, args.cwd, command), this.ctx.sessionId);
    } catch (error) {
      lease.dispose();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    closeProcessStdin(proc);

    let detached = startsInBackground;
    let timedOut = false;
    let stopReason: string | undefined;
    let outputLimitTripped = false;
    let outputBytes = 0;
    let detachScenario: 'foreground_detached' | 'foreground_detached_by_user' = 'foreground_detached_by_user';
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let forceHandle: ReturnType<typeof setTimeout> | undefined;
    const onProcessOutput = (_kind: 'stdout' | 'stderr', text: string): void => {
      outputBytes += Buffer.byteLength(text);
      if (!outputLimitTripped && outputBytes > 16 * 1024 * 1024) {
        outputLimitTripped = true;
        stopReason = outputLimitReason();
        void proc.kill('SIGTERM').catch(() => {});
      }
      builder.write(text);
    };
    const forceStop = async (): Promise<void> => {
      try {
        if (proc.exitCode === null) await proc.kill('SIGKILL');
      } finally {
        await disposeProcess(proc);
        lease.dispose();
      }
    };
    const setFields = (status: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed', exitCode: number | null): void => {
      set?.({
        task: {
          kind: 'process',
          description,
          command,
          pid: proc.pid,
          exitCode,
          parentToolCallId: toolCallId,
          timeoutMs,
          timedOut: status === 'timed_out' || undefined,
          stopReason,
        },
      });
    };
    const armTimeout = (duration: number | undefined): void => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
      if (duration === undefined || duration <= 0) return;
      timeoutHandle = setTimeout(() => {
        timeoutHandle = undefined;
        if (this.allowBackground() && this.autoBackgroundOnTimeout() && !detached) {
          detachScenario = 'foreground_detached';
          detached = true;
          const started = this.backgroundStartedResult(taskId, proc, description, {
            title: 'Command timed out and moved to background',
            brief: `Backgrounded ${taskId} after timeout`,
          }, builder, 'foreground_detached');
          detach?.(started.output, started.brief);
          armTimeout(this.detachTimeoutMs());
          return;
        }
        timedOut = true;
        stopReason = 'Timed out';
        void proc.kill('SIGTERM').catch(() => {});
        const graceMs = resolveAgentTaskConfig(this.config)?.killGracePeriodMs ?? 5_000;
        forceHandle = setTimeout(() => {
          void forceStop();
        }, graceMs);
        forceHandle.unref?.();
      }, duration);
      timeoutHandle.unref?.();
    };
    const requestDetach = (output: string, scenario: 'background_started' | 'foreground_detached' | 'foreground_detached_by_user', brief?: string): void => {
      detached = true;
      detachScenario = scenario === 'background_started' ? 'foreground_detached_by_user' : scenario;
      detach?.(output, brief);
      if (scenario !== 'background_started') armTimeout(this.detachTimeoutMs());
    };
    onDetach?.(() => {
      if (!detached) armTimeout(this.detachTimeoutMs());
      detached = true;
      const started = this.backgroundStartedResult(
        taskId,
        proc,
        description,
        {
          title: 'Task moved to background by the user',
          brief: `Backgrounded ${taskId} by the user`,
        },
        builder,
        detachScenario,
      );
      return {
        content: [{ type: 'text', text: started.output }],
        brief: started.brief,
      };
    });
    setStop(({ reason, abandon }) => {
      if (typeof reason === 'string') stopReason = reason;
      else if (isAbortError(reason)) stopReason = userCancellationReason().message;
      else if (reason instanceof Error) stopReason = reason.message;
      void proc.kill('SIGTERM').catch(() => {});
      const graceMs = resolveAgentTaskConfig(this.config)?.killGracePeriodMs ?? 5_000;
      forceHandle = setTimeout(() => {
        void forceStop().finally(() => {
          setFields('killed', proc.exitCode);
          abandon();
        });
      }, graceMs);
      forceHandle.unref?.();
    });

    if (!startsInBackground) onForegroundTaskStart?.(taskId);
    setFields('running', null);
    armTimeout(startsInBackground ? timeoutMs : foregroundTimeoutMs);
    try {
      if (startsInBackground) {
        const started = this.backgroundStartedResult(taskId, proc, description, {
          title: 'Background task started',
          brief: `Started ${taskId}`,
        });
        requestDetach(started.output, 'background_started', started.brief);
      }
      let status: 'completed' | 'failed' | 'timed_out' | 'killed';
      try {
        const outcome = await executeProcess(proc, signal, onProcessOutput, (text) => write?.(text));
        status = timedOut ? 'timed_out' : outcome.exitCode === 0 ? 'completed' : 'failed';
      } catch (error) {
        status = timedOut ? 'timed_out' : signal.aborted ? 'killed' : 'failed';
        if (!signal.aborted && stopReason === undefined && !(error instanceof ProcessExitError)) {
          stopReason = error instanceof Error ? error.message : String(error);
        }
      } finally {
        lease.dispose();
      }
      setFields(status, proc.exitCode);
      return await this.completionResult(taskId, proc, builder, timeoutMs ?? foregroundTimeoutMs, {
        status,
        stopReason,
        exitCode: proc.exitCode,
      });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (forceHandle !== undefined) clearTimeout(forceHandle);
    }
  }

  private async completionResult(
    taskId: string,
    proc: IHostProcess,
    builder: ToolOutputAccumulator,
    foregroundTimeoutMs: number,
    current: {
      readonly status: 'completed' | 'failed' | 'timed_out' | 'killed';
      readonly stopReason?: string;
      readonly exitCode: number | null;
    },
  ): Promise<ExecutableToolResult> {
    const exitCode = current.exitCode;
    let result: ToolOutputAccumulatorResult;
    if (current.status === 'timed_out') {
      const timeoutLabel = formatTimeoutLabel(foregroundTimeoutMs);
      result = builder.error(`Command killed by timeout (${timeoutLabel})`, {
        brief: `Killed by timeout (${timeoutLabel})`,
      });
    } else if (
      current.status === 'killed' &&
      current.stopReason === userCancellationReason().message
    ) {
      result = builder.error('Interrupted by user', { brief: 'Interrupted by user' });
    } else if (
      (current.status === 'failed' || current.status === 'killed') &&
      current.stopReason !== undefined
    ) {
      result = builder.error(current.stopReason, { brief: current.stopReason });
    } else if (exitCode === 0) {
      result = builder.ok('Command executed successfully.');
    } else {
      if (builder.nChars === 0) builder.write(`Process exited with code ${String(exitCode)}`);
      result = builder.error(`Command failed with exit code: ${String(exitCode)}.`, {
        brief: `Failed with exit code: ${String(exitCode)}`,
      });
    }
    return this.addOutputReference(taskId, result, builder.totalChars);
  }

  private async addOutputReference(
    taskId: string,
    result: ToolOutputAccumulatorResult,
    totalChars: number,
  ): Promise<ExecutableToolResult> {
    if (totalChars <= DEFAULT_TOOL_RESULT_MAX_CHARS) return result;
    const output = await this.taskOutputs.readTaskOutputSnapshot(taskId, 0);
    if (output === undefined || output.outputPath.length === 0) return result;

    const taskOutputHint = this.allowBackground()
      ? `\nnext_step: Use TaskOutput(task_id="${taskId}") to query the task output.`
      : '';
    const taskInfo = `task_id: ${taskId}\noutput_size_bytes: ${String(output.outputSizeBytes)}${taskOutputHint}`;
    const existingSuffix = result.spill?.suffix;
    return {
      ...result,
      spill: {
        outputPath: output.outputPath,
        totalChars,
        suffix: existingSuffix !== undefined ? `${existingSuffix}\n${taskInfo}` : taskInfo,
      },
    };
  }

  private validateRunRequest(
    args: BashInput,
    signal: AbortSignal,
  ): ExecutableToolResult | undefined {
    if (signal.aborted) return { isError: true, output: 'Aborted before command started' };
    if (args.command.length === 0) return { isError: true, output: 'Command cannot be empty.' };
    if (args.run_in_background !== true) return undefined;
    if (!this.allowBackground()) {
      return {
        isError: true,
        output:
          'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
      };
    }
    if (!args.description?.trim()) {
      return {
        isError: true,
        output: 'description is required when run_in_background is true.',
      };
    }
    return undefined;
  }

  private backgroundStartedResult(
    taskId: string,
    proc: IHostProcess,
    description: string,
    labels: { title: string; brief: string },
    builder = new ToolOutputAccumulator(),
    scenario: 'background_started' | 'foreground_detached' | 'foreground_detached_by_user' = 'background_started',
  ): ExecutableToolResult & { readonly output: string; readonly brief: string } {
    const status = 'running';
    const detachedByUser = scenario === 'foreground_detached_by_user' ? 'detached_by_user: true\n' : '';
    const metadata =
      `task_id: ${taskId}\n` +
      `pid: ${String(proc.pid)}\n` +
      `description: ${description}\n` +
      `status: ${status}\n` +
      detachedByUser +
      `automatic_notification: true\n` +
      this.nextStepLines(scenario) +
      'human_shell_hint: The task is visible in the background-task panel.';

    const foregroundResult = builder.ok('');
    const foregroundOutput = foregroundResult.output.length > 0 ? foregroundResult.output : '';
    const result: ExecutableToolResult & {
      readonly brief: string;
      readonly output: string;
    } = {
      isError: false,
      output:
        foregroundOutput.length === 0
          ? metadata
          : `${metadata}\n\nforeground_output:\n${foregroundOutput}`,
      brief: labels.brief,
    };
    return result;
  }

  private nextStepLines(
    scenario: 'background_started' | 'foreground_detached' | 'foreground_detached_by_user',
  ): string {
    if (scenario === 'foreground_detached' || scenario === 'foreground_detached_by_user') {
      const avoid = this.allowBackground()
        ? 'do NOT wait, poll, or call TaskOutput on it'
        : 'do NOT wait or poll';
      const moved =
        scenario === 'foreground_detached_by_user'
          ? 'The user moved this task to the background.'
          : 'The task now runs in the background.';
      return (
        `next_step: ${moved} You will be automatically notified ` +
        `when it completes — ${avoid}; continue with your current work.\n`
      );
    }
    if (!this.allowBackground()) {
      return 'next_step: You will be automatically notified when it completes.\n';
    }
    return (
      'next_step: The completion arrives automatically in a later turn — do NOT wait, poll, ' +
      'or call TaskOutput on it; continue with your current work.\n' +
      'next_step: Use TaskStop only if the task must be cancelled.\n'
    );
  }
}

registerAgentToolService(IBashTool, BashTool, {
  name: 'Bash',
  domain: 'os/backends',
  requiredEnvironmentCapabilities: ['process'],
});

function formatTimeoutLabel(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${String(timeoutMs / 1000)}s` : `${String(timeoutMs)}ms`;
}

function foregroundDescription(args: BashInput): string {
  const explicit = args.description?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const preview = args.command.length > 60 ? `${args.command.slice(0, 60)}…` : args.command;
  return `Bash: ${preview}`;
}

function closeProcessStdin(proc: IHostProcess): void {
  try {
    proc.stdin.end();
  } catch {
  }
}

function outputLimitReason(): string {
  return (
    'Output limit exceeded: the command produced more than 16 MiB and was ' +
    'terminated. Redirect large output to a file (e.g. `command > out.txt`) and ' +
    'inspect it in slices instead.'
  );
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

const WINDOWS_NUL_REDIRECT = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(WINDOWS_NUL_REDIRECT, '$1/dev/null');
}

type ProcessOutputKind = 'stdout' | 'stderr';

const STREAM_DRAIN_GRACE_MS = 250;

async function executeProcess(
  proc: IHostProcess,
  signal: AbortSignal,
  onOutput: (kind: ProcessOutputKind, text: string) => void,
  write: (text: string) => void,
): Promise<{ readonly exitCode: number | null }> {
  const forwardOutput = (kind: ProcessOutputKind, text: string): void => {
    if (text.length === 0) return;
    write(text);
    onOutput(kind, text);
  };
  const streamDrained = Promise.all([
    observeProcessStream(proc.stdout, 'stdout', signal, forwardOutput),
    observeProcessStream(proc.stderr, 'stderr', signal, forwardOutput),
  ]).then(() => undefined);
  void streamDrained.catch(() => {});

  const requestStop = (): void => {
    void proc.kill('SIGTERM').catch(() => {});
  };
  if (signal.aborted) requestStop();
  else signal.addEventListener('abort', requestStop, { once: true });

  try {
    const exitCode = await proc.wait();
    await waitForStreamDrain(streamDrained);
    signal.removeEventListener('abort', requestStop);
    if (signal.aborted) throw signal.reason;
    if (exitCode !== 0) throw new ProcessExitError(exitCode);
    return { exitCode };
  } catch (error) {
    await waitForStreamDrainSettled(streamDrained);
    signal.removeEventListener('abort', requestStop);
    throw error;
  } finally {
    await disposeProcess(proc);
  }
}

function observeProcessStream(
  stream: Readable,
  kind: ProcessOutputKind,
  signal: AbortSignal,
  onChunk: (kind: ProcessOutputKind, text: string) => void,
): Promise<void> {
  stream.setEncoding('utf8');
  const onData = (chunk: string): void => {
    onChunk(kind, chunk);
  };
  stream.on('data', onData);

  return new Promise<void>((resolve, reject) => {
    let ended = false;
    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    };
    const done = (): void => {
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => {
      ended = true;
      done();
    };
    const onClose = (): void => {
      if (ended || signal.aborted) {
        done();
        return;
      }
      fail(createPrematureCloseError());
    };
    const onError = (error: Error): void => {
      if (signal.aborted) done();
      else fail(error);
    };
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
  });
}

async function waitForStreamDrain(streamDrained: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      streamDrained,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, STREAM_DRAIN_GRACE_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForStreamDrainSettled(streamDrained: Promise<void>): Promise<void> {
  try {
    await waitForStreamDrain(streamDrained);
  } catch {
  }
}

class ProcessExitError extends Error {
  constructor(readonly exitCode: number | null) {
    super(`Process exited with code ${exitCode}`);
    this.name = 'ProcessExitError';
  }
}

function createPrematureCloseError(): Error {
  const error = new Error('Premature close') as NodeJS.ErrnoException;
  error.code = 'ERR_STREAM_PREMATURE_CLOSE';
  return error;
}
