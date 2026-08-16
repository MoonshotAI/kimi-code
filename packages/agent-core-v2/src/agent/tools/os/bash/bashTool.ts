import { IAgentTaskService } from '#/agent/task/task';
import { resolveAgentTaskConfig } from '#/agent/task/configSection';
import { IConfigService } from '#/app/config/config';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { ExecutableToolResult, ToolExecution, ToolUpdate } from '#/tool/toolContract';
import {
  type ExecutableToolResultBuilderResult,
  ToolResultBuilder,
} from '#/tool/result-builder';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { userCancellationReason } from '#/_base/utils/abort';
import bashDescriptionTemplate from './bash.md?raw';
import { ProcessTask } from './process-task';
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

const SHELL_TIMEOUT_VARS = {
  DEFAULT_TIMEOUT_S,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
  MAX_BACKGROUND_TIMEOUT_S,
};

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

function renderBashDescription(shellName: string): string {
  return renderPrompt(bashDescriptionTemplate, { ...SHELL_TIMEOUT_VARS, SHELL_NAME: shellName });
}

function withoutBackgroundDescription(description: string): string {
  return description
    .replace(
      /\r?\n\r?\nIf `run_in_background=true`,[\s\S]*?point them to the `\/tasks` command, which opens an interactive panel; it has no subcommands\./,
      '\n\nBackground execution is disabled for this agent. Do not set `run_in_background=true`.',
    )
    .replace(
      ` For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to ${String(DEFAULT_TIMEOUT_S)}s and allow up to ${String(MAX_TIMEOUT_S)}s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.`,
      ` For possibly long-running commands, set the \`timeout\` argument in seconds. The default is ${String(DEFAULT_TIMEOUT_S)}s; foreground commands allow up to ${String(MAX_TIMEOUT_S)}s; a foreground command that hits its timeout is killed.`,
    )
    .replace(
      /\r?\n- Prefer `run_in_background=true`[\s\S]*?conversation to continue before the command finishes\./,
      '\n- Do not set `run_in_background=true`; background task management tools are not available.',
    );
}

function withoutAutoBackgroundOnTimeout(description: string): string {
  return description.replace(
    ' When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.',
    ' A foreground command that hits its timeout is killed.',
  );
}

export class BashTool implements IBashTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Bash' as const;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BashInputSchema);

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
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
    const renderedDescription = renderBashDescription(inspectAgentRuntime(this.runtime).environment.shellName);
    if (!this.allowBackground()) return withoutBackgroundDescription(renderedDescription);
    if (!this.autoBackgroundOnTimeout()) {
      return withoutAutoBackgroundOnTimeout(renderedDescription);
    }
    return renderedDescription;
  }

  resolveExecution(args: BashInput): ToolExecution {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    return {
      description: args.run_in_background
        ? `Starting background: ${preview}`
        : `Running: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: args.cwd ?? this.ctx.cwd,
        description: args.description,
        language: 'bash',
      },
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      execute: ({ signal, onUpdate, onForegroundTaskStart }) =>
        this.execution(args, signal, onUpdate, onForegroundTaskStart),
    };
  }

  private spawn(
    processService: IHostProcessService,
    env: HostEnvironmentInfo,
    effectiveCwd: string,
    command: string,
  ): Promise<IHostProcess> {
    const shellCwd = env.osKind === 'Windows' ? windowsPathToPosixPath(effectiveCwd) : effectiveCwd;
    const shellCommand = `cd ${shellQuote(shellCwd)} && ${command}`;
    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
      SHELL: env.shellPath,
    };

    return processService.spawn(env.shellPath, ['-c', shellCommand], { env: noninteractiveEnv });
  }

  private async execution(
    args: BashInput,
    signal: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
    onForegroundTaskStart?: (taskId: string) => void,
  ): Promise<ExecutableToolResult> {
    const validationError = this.validateRunRequest(args, signal);
    if (validationError !== undefined) return validationError;

    const startsInBackground = args.run_in_background === true;
    const foregroundTimeoutMs = normalizeTimeoutMs(args.timeout, false);
    const lease = this.runtime.acquire(['process']);
    const view = new RuntimeWorkspaceView(lease.runtime, this.workspaceCtx);
    const env = lease.runtime.environment;
    const command = env.osKind === 'Windows' ? rewriteWindowsNullRedirect(args.command) : args.command;
    const effectiveCwd = view.resolve(args.cwd ?? view.workDir);
    const description = startsInBackground ? args.description!.trim() : foregroundDescription(args);
    const timeoutMs = startsInBackground
      ? args.disable_timeout
        ? undefined
        : normalizeTimeoutMs(args.timeout, true)
      : foregroundTimeoutMs;

    const builder = new ToolResultBuilder();
    let proc: IHostProcess;
    try {
      proc = lease.track(await this.spawn(lease.runtime.process!, env, effectiveCwd, command));
    } catch (error) {
      lease.dispose();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    closeProcessStdin(proc);

    let collectForegroundOutput = !startsInBackground;
    let foregroundOutputPersisted = false;
    let foregroundTaskId: string | undefined;
    const onProcessOutput = startsInBackground
      ? undefined
      : (kind: 'stdout' | 'stderr', text: string): void => {
          if (!collectForegroundOutput) return;
          onUpdate?.({ kind, text });
          builder.write(text);
          if (!foregroundOutputPersisted && builder.truncated && foregroundTaskId !== undefined) {
            this.tasks.persistOutput(foregroundTaskId);
            foregroundOutputPersisted = true;
          }
        };

    let taskId: string;
    try {
      taskId = this.tasks.registerTask(
        new ProcessTask(proc, command, description, onProcessOutput, () => lease.dispose()),
        {
          detached: startsInBackground,
          timeoutMs,
          detachTimeoutMs: this.detachTimeoutMs(),
          autoBackgroundOnTimeout: this.allowBackground() && this.autoBackgroundOnTimeout(),
          signal: startsInBackground ? undefined : signal,
        },
      );
      foregroundTaskId = startsInBackground ? undefined : taskId;
    } catch (error) {
      collectForegroundOutput = false;
      await killSpawnedProcess(proc);
      lease.dispose();
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    if (!startsInBackground) onForegroundTaskStart?.(taskId);

    if (startsInBackground) {
      return this.backgroundStartedResult(taskId, proc, description, {
        title: 'Background task started',
        brief: `Started ${taskId}`,
      });
    }

    try {
      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached' || release === 'timeout_detached') {
        collectForegroundOutput = false;
        const labels =
          release === 'timeout_detached'
            ? {
                title: 'Command timed out and moved to background',
                brief: `Backgrounded ${taskId} after timeout`,
              }
            : {
                title: 'Task moved to background',
                brief: `Backgrounded ${taskId}`,
              };
        return this.backgroundStartedResult(
          taskId,
          proc,
          description,
          labels,
          builder,
          'foreground_detached',
        );
      }

      return await this.foregroundCompletionResult(taskId, proc, builder, foregroundTimeoutMs);
    } finally {
      collectForegroundOutput = false;
    }
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

  private async foregroundCompletionResult(
    taskId: string,
    proc: IHostProcess,
    builder: ToolResultBuilder,
    foregroundTimeoutMs: number,
  ): Promise<ExecutableToolResult> {
    const current = this.tasks.getTask(taskId);
    const exitCode = current?.kind === 'process' ? current.exitCode : proc.exitCode;
    let result: ExecutableToolResultBuilderResult;
    if (current?.status === 'timed_out') {
      const timeoutLabel = formatTimeoutLabel(foregroundTimeoutMs);
      result = builder.error(`Command killed by timeout (${timeoutLabel})`, {
        brief: `Killed by timeout (${timeoutLabel})`,
      });
    } else if (
      current?.status === 'killed' &&
      current.stopReason === userCancellationReason().message
    ) {
      result = builder.error('Interrupted by user', { brief: 'Interrupted by user' });
    } else if (
      (current?.status === 'failed' || current?.status === 'killed') &&
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
    return this.addForegroundOutputReference(taskId, result);
  }

  private async addForegroundOutputReference(
    taskId: string,
    result: ExecutableToolResultBuilderResult,
  ): Promise<ExecutableToolResult> {
    if (!result.truncated) return result;
    const output = await this.tasks.getOutputSnapshot(taskId, 0);
    if (!output.fullOutputAvailable || output.outputPath === undefined) return result;

    const taskOutputHint = this.allowBackground()
      ? `, or TaskOutput(task_id="${taskId}")`
      : '';
    const reference =
      `\n\n[Full output saved]\n` +
      `task_id: ${taskId}\n` +
      `output_path: ${output.outputPath}\n` +
      `output_size_bytes: ${String(output.outputSizeBytes)}\n` +
      `next_step: Use Read with output_path to page through the full log${taskOutputHint}.`;
    return { ...result, output: `${result.output}${reference}` };
  }

  private backgroundStartedResult(
    taskId: string,
    proc: IHostProcess,
    description: string,
    labels: { title: string; brief: string },
    builder = new ToolResultBuilder(),
    scenario: 'background_started' | 'foreground_detached' = 'background_started',
  ): ExecutableToolResult {
    const status = this.tasks.getTask(taskId)?.status ?? 'running';
    const metadata =
      `task_id: ${taskId}\n` +
      `pid: ${String(proc.pid)}\n` +
      `description: ${description}\n` +
      `status: ${status}\n` +
      `automatic_notification: true\n` +
      this.nextStepLines(scenario) +
      'human_shell_hint: Tell the human to run /tasks to open the interactive background-task panel.';

    const foregroundResult = builder.ok('');
    const foregroundOutput = foregroundResult.output.length > 0 ? foregroundResult.output : '';
    const result: ExecutableToolResult & {
      readonly brief: string;
      readonly truncated: boolean;
    } = {
      isError: false,
      output:
        foregroundOutput.length === 0
          ? metadata
          : `${metadata}\n\nforeground_output:\n${foregroundOutput}`,
      brief: labels.brief,
      truncated: foregroundResult.truncated,
    };
    return result;
  }

  private nextStepLines(
    scenario: 'background_started' | 'foreground_detached',
  ): string {
    if (scenario === 'foreground_detached') {
      const avoid = this.allowBackground()
        ? 'do NOT wait, poll, or call TaskOutput on it'
        : 'do NOT wait or poll';
      return (
        'next_step: The task now runs in the background. You will be automatically notified ' +
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
  requiredRuntimeCapabilities: ['process'],
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

async function killSpawnedProcess(proc: IHostProcess): Promise<void> {
  try {
    await proc.kill('SIGTERM');
  } catch {
  } finally {
    await disposeProcess(proc);
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function windowsPathToPosixPath(path: string): string {
  if (path.startsWith('\\\\')) {
    return path.replaceAll('\\', '/');
  }

  const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = path.slice(2).replaceAll('\\', '/');
    return `/${drive}${rest.startsWith('/') ? rest : `/${rest}`}`;
  }

  return path.replaceAll('\\', '/');
}

const WINDOWS_NUL_REDIRECT = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(WINDOWS_NUL_REDIRECT, '$1/dev/null');
}
